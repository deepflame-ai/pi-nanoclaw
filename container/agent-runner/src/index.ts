/**
 * NanoClaw Agent Runner (Pi)
 * Runs inside a container, receives config via stdin, outputs result markers to stdout.
 */

import fs from 'fs';
import path from 'path';

import { Type } from '@sinclair/typebox';
import { CronExpressionParser } from 'cron-parser';
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const IPC_TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner-pi] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;

  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function shouldClose(): boolean {
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }
  return true;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          type?: string;
          text?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }

    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }

      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }

      setTimeout(poll, IPC_POLL_MS);
    };

    poll();
  });
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';

  const msg = message as {
    role?: string;
    content?: unknown;
  };

  if (msg.role !== 'assistant') return '';

  if (typeof msg.content === 'string') return msg.content.trim();

  if (!Array.isArray(msg.content)) return '';

  const text = msg.content
    .filter(
      (block): block is { type?: string; text?: string } =>
        !!block && typeof block === 'object',
    )
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim();

  return text;
}

function createNanoclawTools(input: ContainerInput): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  tools.push({
    name: 'send_message',
    label: 'Send Message',
    description:
      "Send a message to the user/group immediately. Use this for progress updates or multi-message workflows.",
    parameters: Type.Object({
      text: Type.String({ description: 'Message text to send.' }),
      sender: Type.Optional(
        Type.String({
          description: 'Optional sender identity for channel-specific rendering.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = params as { text: string; sender?: string };
      writeIpcFile(IPC_MESSAGES_DIR, {
        type: 'message',
        chatJid: input.chatJid,
        text: p.text,
        sender: p.sender,
        groupFolder: input.groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: 'text', text: 'Message sent.' }],
        details: {},
      };
    },
  });

  tools.push({
    name: 'schedule_task',
    label: 'Schedule Task',
    description:
      'Schedule a recurring or one-time task. Supports cron, interval(ms), and once(local timestamp).',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Task prompt to execute when due.' }),
      schedule_type: Type.String({
        description: 'cron | interval | once',
      }),
      schedule_value: Type.String({
        description:
          'cron expression, interval in ms, or local timestamp like 2026-02-01T15:30:00',
      }),
      context_mode: Type.Optional(
        Type.String({ description: 'group | isolated (default: group)' }),
      ),
      target_group_jid: Type.Optional(
        Type.String({
          description: 'Main group only: target JID. Defaults to current group.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = params as {
        prompt: string;
        schedule_type: string;
        schedule_value: string;
        context_mode?: string;
        target_group_jid?: string;
      };

      if (!['cron', 'interval', 'once'].includes(p.schedule_type)) {
        return {
          content: [{ type: 'text', text: 'Invalid schedule_type.' }],
          details: {},
          isError: true,
        };
      }

      if (p.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(p.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid cron: ${p.schedule_value}`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      }

      if (p.schedule_type === 'interval') {
        const ms = parseInt(p.schedule_value, 10);
        if (Number.isNaN(ms) || ms <= 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid interval: ${p.schedule_value}`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      }

      if (p.schedule_type === 'once') {
        const hasTzSuffix =
          /[Zz]$/.test(p.schedule_value) || /[+-]\d{2}:\d{2}$/.test(p.schedule_value);
        if (hasTzSuffix) {
          return {
            content: [
              {
                type: 'text',
                text: 'Use local timestamp without timezone suffix (no Z).',
              },
            ],
            details: {},
            isError: true,
          };
        }
        const date = new Date(p.schedule_value);
        if (Number.isNaN(date.getTime())) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid timestamp: ${p.schedule_value}`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      }

      const targetJid = input.isMain && p.target_group_jid ? p.target_group_jid : input.chatJid;

      writeIpcFile(IPC_TASKS_DIR, {
        type: 'schedule_task',
        prompt: p.prompt,
        schedule_type: p.schedule_type,
        schedule_value: p.schedule_value,
        context_mode: p.context_mode === 'isolated' ? 'isolated' : 'group',
        targetJid,
        createdBy: input.groupFolder,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: 'text', text: 'Task scheduling requested.' }],
        details: {},
      };
    },
  });

  tools.push({
    name: 'list_tasks',
    label: 'List Tasks',
    description:
      "List scheduled tasks. Main group sees all; non-main sees only this group's tasks.",
    parameters: Type.Object({}),
    execute: async () => {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [{ type: 'text', text: 'No scheduled tasks found.' }],
          details: {},
        };
      }

      try {
        const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
          id: string;
          groupFolder: string;
          prompt: string;
          schedule_type: string;
          schedule_value: string;
          status: string;
          next_run: string | null;
        }>;

        const tasks = input.isMain
          ? allTasks
          : allTasks.filter((t) => t.groupFolder === input.groupFolder);

        if (tasks.length === 0) {
          return {
            content: [{ type: 'text', text: 'No scheduled tasks found.' }],
            details: {},
          };
        }

        const text = tasks
          .map(
            (t) =>
              `- [${t.id}] ${t.prompt.slice(0, 60)} (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
          )
          .join('\n');

        return {
          content: [{ type: 'text', text: `Scheduled tasks:\n${text}` }],
          details: {},
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read tasks: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  const makeTaskStateTool = (
    name: 'pause_task' | 'resume_task' | 'cancel_task',
    action: string,
  ): ToolDefinition => ({
    name,
    label: action,
    description: `${action} a scheduled task by ID.`,
    parameters: Type.Object({
      task_id: Type.String({ description: 'Task ID' }),
    }),
    execute: async (_toolCallId, params) => {
      const p = params as { task_id: string };
      writeIpcFile(IPC_TASKS_DIR, {
        type: name,
        taskId: p.task_id,
        groupFolder: input.groupFolder,
        isMain: input.isMain,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: 'text', text: `Task ${p.task_id} ${action.toLowerCase()} requested.` }],
        details: {},
      };
    },
  });

  tools.push(makeTaskStateTool('pause_task', 'Pause'));
  tools.push(makeTaskStateTool('resume_task', 'Resume'));
  tools.push(makeTaskStateTool('cancel_task', 'Cancel'));

  tools.push({
    name: 'refresh_groups',
    label: 'Refresh Groups',
    description: 'Main group only: refresh available group metadata snapshot.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!input.isMain) {
        return {
          content: [{ type: 'text', text: 'Only main group can refresh groups.' }],
          details: {},
          isError: true,
        };
      }

      writeIpcFile(IPC_TASKS_DIR, {
        type: 'refresh_groups',
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: 'text', text: 'Group refresh requested.' }],
        details: {},
      };
    },
  });

  tools.push({
    name: 'register_group',
    label: 'Register Group',
    description: 'Main group only: register a new group by JID/folder/trigger.',
    parameters: Type.Object({
      jid: Type.String(),
      name: Type.String(),
      folder: Type.String(),
      trigger: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      if (!input.isMain) {
        return {
          content: [{ type: 'text', text: 'Only main group can register groups.' }],
          details: {},
          isError: true,
        };
      }

      const p = params as {
        jid: string;
        name: string;
        folder: string;
        trigger: string;
      };

      writeIpcFile(IPC_TASKS_DIR, {
        type: 'register_group',
        jid: p.jid,
        name: p.name,
        folder: p.folder,
        trigger: p.trigger,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{ type: 'text', text: `Group ${p.name} registration requested.` }],
        details: {},
      };
    },
  });

  return tools;
}

async function createPiSession(input: ContainerInput): Promise<{
  session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  sessionPath: string | undefined;
}> {
  const cwd = '/workspace/group';
  const agentDir = '/home/node/.pi/agent';
  const sessionsDir = path.join(agentDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'));

  const apiKey =
    input.secrets?.ANTHROPIC_API_KEY || input.secrets?.ANTHROPIC_AUTH_TOKEN;
  if (apiKey) {
    authStorage.setRuntimeApiKey('anthropic', apiKey);
  }

  // Expose forwarded provider/base-url keys to Pi provider discovery.
  for (const [key, value] of Object.entries(input.secrets || {})) {
    process.env[key] = value;
  }

  // Back-compat alias: older fork configs used GOOGLE_API_KEY.
  // Pi's documented key is GEMINI_API_KEY.
  if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
    process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
  }

  const sessionFile = input.sessionId;
  const sessionManager =
    sessionFile && fs.existsSync(sessionFile)
      ? SessionManager.open(sessionFile)
      : SessionManager.create(cwd, sessionsDir);

  const modelRegistry = new ModelRegistry(authStorage);
  const settingsManager = SettingsManager.inMemory();

  const result = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    authStorage,
    modelRegistry,
    settingsManager,
    tools: createCodingTools(cwd),
    customTools: createNanoclawTools(input),
  });

  return {
    session: result.session,
    sessionPath: result.session.sessionFile,
  };
}

async function runPrompt(
  session: Awaited<ReturnType<typeof createAgentSession>>['session'],
  prompt: string,
  sessionPath: string | undefined,
): Promise<{ closedDuringPrompt: boolean }> {
  let closedDuringPrompt = false;

  const unsubscribe = session.subscribe((event) => {
    if (event.type !== 'message_end') return;

    const text = extractAssistantText(event.message);
    if (!text) return;

    writeOutput({
      status: 'success',
      result: text,
      newSessionId: sessionPath,
    });
  });

  const timer = setInterval(() => {
    if (closedDuringPrompt) return;

    if (shouldClose()) {
      closedDuringPrompt = true;
      session.abort().catch((err) => {
        log(`Failed to abort session after close sentinel: ${String(err)}`);
      });
      return;
    }

    const incoming = drainIpcInput();
    if (incoming.length === 0) return;

    for (const msg of incoming) {
      session.followUp(msg).catch((err) => {
        log(`Failed to queue follow-up: ${String(err)}`);
      });
    }
  }, IPC_POLL_MS);

  try {
    await session.prompt(prompt);
  } finally {
    clearInterval(timer);
    unsubscribe();
  }

  return { closedDuringPrompt };
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdin = await readStdin();
    input = JSON.parse(stdin) as ContainerInput;
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      // ignore
    }
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore stale sentinel
  }

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) prompt += `\n${pending.join('\n')}`;

  try {
    const { session, sessionPath } = await createPiSession(input);

    // Remove secrets from memory before any logs/errors can stringify input.
    delete input.secrets;

    while (true) {
      const run = await runPrompt(session, prompt, sessionPath);

      if (run.closedDuringPrompt) {
        break;
      }

      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionPath,
      });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) break;

      prompt = nextMessage;
    }

    session.dispose();
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main();

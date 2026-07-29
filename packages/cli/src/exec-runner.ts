import {
  SessionManager,
  createOpenAIClient,
  resolveCurrentSettings,
  type SessionManagerOptions,
} from "@vegamo/deepcode-core";
import { buildExecPrompt, type ExecInputStream } from "./exec-input";
import { writeStderrLine, writeStdoutLine } from "./utils/stdio-helpers";

type ExecSessionManager = Pick<
  SessionManager,
  | "dispose"
  | "getActiveSessionId"
  | "getSession"
  | "handleUserPrompt"
  | "initMcpServers"
  | "interruptActiveSession"
  | "setActiveSessionId"
>;

interface SignalTarget {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export interface ExecRunnerOptions {
  prompt: string;
  projectRoot: string;
  resumeSessionId?: string;
  input?: ExecInputStream;
}

export interface ExecRunnerDependencies {
  buildPrompt: typeof buildExecPrompt;
  createSessionManager: (options: SessionManagerOptions) => ExecSessionManager;
  resolveSettings: typeof resolveCurrentSettings;
  signalTarget: SignalTarget;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
}

const defaultDependencies: ExecRunnerDependencies = {
  buildPrompt: buildExecPrompt,
  createSessionManager: (options) => new SessionManager(options),
  resolveSettings: resolveCurrentSettings,
  signalTarget: process,
  writeStdoutLine,
  writeStderrLine,
};

/** Run exactly one model turn without mounting Ink or requiring a TTY. */
export async function runExecMode(
  options: ExecRunnerOptions,
  dependencies: Partial<ExecRunnerDependencies> = {}
): Promise<number> {
  const deps = { ...defaultDependencies, ...dependencies };
  let manager: ExecSessionManager | null = null;
  let interrupted = false;

  const handleSigint = (): void => {
    interrupted = true;
    manager?.interruptActiveSession();
  };

  deps.signalTarget.on("SIGINT", handleSigint);
  try {
    const settings = deps.resolveSettings(options.projectRoot);
    manager = deps.createSessionManager({
      projectRoot: options.projectRoot,
      createOpenAIClient: () => createOpenAIClient(options.projectRoot),
      getResolvedSettings: () => deps.resolveSettings(options.projectRoot),
      renderMarkdown: (text) => text,
      nonInteractive: true,
      onAssistantMessage: () => {},
    });

    await manager.initMcpServers(settings.mcpServers);
    if (interrupted) {
      return 130;
    }

    if (options.resumeSessionId) {
      if (!manager.getSession(options.resumeSessionId)) {
        deps.writeStderrLine(`No saved session found with ID "${options.resumeSessionId}".`);
        return 1;
      }
    }

    const prompt = await deps.buildPrompt(options.prompt, options.input ?? process.stdin);
    if (interrupted) {
      return 130;
    }

    if (options.resumeSessionId) {
      manager.setActiveSessionId(options.resumeSessionId);
    }

    await manager.handleUserPrompt({ text: prompt });
    const sessionId = manager.getActiveSessionId();
    const session = sessionId ? manager.getSession(sessionId) : null;

    if (interrupted || session?.status === "interrupted") {
      if (!interrupted) {
        deps.writeStderrLine("Execution was interrupted.");
      }
      return interrupted ? 130 : 1;
    }
    if (!session) {
      deps.writeStderrLine("Execution failed before a session was created.");
      return 1;
    }
    if (session.status === "ask_permission") {
      deps.writeStderrLine(
        "Execution requires permission confirmation, which is unavailable in --exec mode. Update permissions or run interactively."
      );
      return 1;
    }
    if (session.status === "waiting_for_user") {
      deps.writeStderrLine("Execution requires user input, which is unavailable in --exec mode.");
      return 1;
    }
    if (session.status !== "completed") {
      deps.writeStderrLine(
        session.failReason ? `Execution failed: ${session.failReason}` : `Execution failed (${session.status}).`
      );
      return 1;
    }

    deps.writeStdoutLine(session.assistantReply ?? "");
    return 0;
  } catch (error) {
    if (interrupted) {
      return 130;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.writeStderrLine(`deepcode: ${message}`);
    return 1;
  } finally {
    deps.signalTarget.off("SIGINT", handleSigint);
    manager?.dispose();
  }
}

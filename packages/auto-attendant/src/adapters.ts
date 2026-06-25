import { execFile } from 'node:child_process';
import type { Responder, ResponderInput, ResponderResult } from './responder.js';
import { buildPrompt, parseConfidence } from './responder.js';

/**
 * Vendor adapter stubs.
 *
 * Each shells out to a vendor CLI (Claude/Codex/Gemini) with a prompt built by
 * {@link buildPrompt}, which fences the untrusted question and instructs the
 * model to answer ONLY from files under `cwd`. These are STUBS: the exec wiring,
 * cwd scoping, and confidence parsing are real, but flags/auth/streaming are
 * intentionally minimal and meant to be hardened per vendor.
 *
 * SECURITY: the prompt is passed via the CLI's prompt FLAG argument (argv), not
 * via a shell string — we use {@link execFile} (no shell), so the untrusted
 * question is never interpreted by a shell. The child's `cwd` is the project
 * directory, scoping any file reads the vendor performs.
 */

/** Options shared by every shell-out adapter. */
export interface ShellResponderOptions {
  /** Override the executable name/path (default per vendor). */
  readonly bin?: string;
  /** Extra argv inserted before the prompt argument. */
  readonly extraArgs?: readonly string[];
  /** Hard timeout for the child process, ms. Default 120_000. */
  readonly timeoutMs?: number;
  /** Max stdout bytes to buffer. Default 1 MiB. */
  readonly maxBuffer?: number;
  /** Seam for tests: replace the actual process spawn. */
  readonly run?: RunFn;
}

/** The exec seam. Returns the child's stdout. Throws on nonzero exit/timeout. */
export type RunFn = (
  bin: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; maxBuffer: number },
) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** Default {@link RunFn}: execFile (no shell), stdout captured, stdin empty. */
const defaultRun: RunFn = (bin, args, opts) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(
      bin,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
    // No prompt is fed over stdin; close it so the CLI doesn't wait on a TTY.
    child.stdin?.end();
  });

/**
 * Base for the vendor stubs. Subclasses only declare their id, default binary,
 * and how the prompt is turned into argv (the prompt flag differs per CLI).
 */
abstract class ShellResponder implements Responder {
  abstract readonly id: string;
  protected abstract readonly defaultBin: string;
  /** Build the argv for this CLI given the prompt text. */
  protected abstract promptArgs(prompt: string): readonly string[];

  readonly #opts: ShellResponderOptions;
  constructor(opts: ShellResponderOptions = {}) {
    this.#opts = opts;
  }

  async answer(input: ResponderInput): Promise<ResponderResult> {
    const prompt = buildPrompt(input);
    const bin = this.#opts.bin ?? this.defaultBin;
    const args = [...(this.#opts.extraArgs ?? []), ...this.promptArgs(prompt)];
    const run = this.#opts.run ?? defaultRun;

    const stdout = await run(bin, args, {
      cwd: input.cwd,
      timeoutMs: this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: this.#opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });
    return parseConfidence(stdout);
  }
}

/**
 * Anthropic Claude CLI: `claude -p "<prompt>" --allowedTools …` (print mode).
 *
 * The read-only tool allowlist lets the agent actually inspect the project to
 * answer, while default-denying everything else (no edits, no arbitrary shell).
 * stdin is closed by {@link defaultRun}, so it never blocks waiting for input.
 */
export class ClaudeResponder extends ShellResponder {
  readonly id = 'claude';
  protected readonly defaultBin = 'claude';
  protected override promptArgs(prompt: string): readonly string[] {
    return ['-p', prompt, '--allowedTools', 'LS', 'Glob', 'Grep', 'Read', 'Bash(ls:*)'];
  }
}

/** OpenAI Codex CLI: `codex exec "<prompt>"` (one-shot exec). */
export class CodexResponder extends ShellResponder {
  readonly id = 'codex';
  protected readonly defaultBin = 'codex';
  protected override promptArgs(prompt: string): readonly string[] {
    return ['exec', prompt];
  }
}

/** Google Gemini CLI: `gemini -p "<prompt>"` (prompt mode). */
export class GeminiResponder extends ShellResponder {
  readonly id = 'gemini';
  protected readonly defaultBin = 'gemini';
  protected override promptArgs(prompt: string): readonly string[] {
    return ['-p', prompt];
  }
}

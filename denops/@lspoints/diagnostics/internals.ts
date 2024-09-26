import type { Denops } from "jsr:@denops/std@^7.1.0";
import { ensure } from "jsr:@core/unknownutil@^4.3.0/ensure";
import { is } from "jsr:@core/unknownutil@^4.3.0/is";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import { ShowOptions } from "../diagnostics.ts";

export const severityString = [
  "error",
  "warning",
  "information",
  "hint",
] as const;

export type SeverityString = typeof severityString[number];

export interface DiagnosticsPublisher {
  initialize(denops: Denops): Promise<void>;
  publish(
    denops: Denops,
    clientName: string,
    bufnr: number,
    diagnostics: LSP.Diagnostic[],
    signal: AbortSignal,
  ): Promise<void>;
}

export type DiagnosticPreviewOptions = Required<ShowOptions>;

export interface DiagnosticsPreviewer {
  show(
    denops: Denops,
    diagnostic: LSP.Diagnostic | undefined,
    options: DiagnosticPreviewOptions,
  ): Promise<void>;
}

export function clamp(v: number, min: number, max: number): number {
  return v > max ? max : v < min ? min : v;
}

export function capitalize(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

export function getSeverityString(
  severity: LSP.DiagnosticSeverity,
): SeverityString {
  switch (severity) {
    case LSP.DiagnosticSeverity.Error:
      return "error";
    case LSP.DiagnosticSeverity.Warning:
      return "warning";
    case LSP.DiagnosticSeverity.Information:
      return "information";
    case LSP.DiagnosticSeverity.Hint:
      return "hint";
  }
}

export async function getBufferLineCount(
  denops: Denops,
  bufnr: number,
): Promise<number | undefined> {
  const [bufloaded, lineCount] = ensure(
    await denops.eval(`[
        bufloaded(${bufnr}),
        getbufinfo(${bufnr})->get(0, {})->get('linecount', 0),
      ]`.replace(/\s/g, "")),
    is.TupleOf([is.Number, is.Number]),
  );
  if (!bufloaded || lineCount <= 0) {
    return undefined;
  }
  return lineCount;
}

import type { Denops } from "jsr:@denops/std@^7.1.0";
import { batch } from "jsr:@denops/std@^7.1.0/batch";
import * as fn from "jsr:@denops/std@^7.1.0/function";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import {
  type HighlightParam,
  setHighlights,
} from "jsr:@mityu/lspoints-toolkit@^0.1.2/highlight";
import {
  capitalize,
  DiagnosticsPublisher,
  getSeverityString,
  SeverityString,
  severityString,
} from "../internals.ts";

export class SignPublisher implements DiagnosticsPublisher {
  async initialize(denops: Denops) {
    const highlights = [
      { name: "LspointsDiagnosticsSignError", linksto: "Error" },
      { name: "LspointsDiagnosticsSignWarning", linksto: "WarningMsg" },
      { name: "LspointsDiagnosticsSignInformation", linksto: "Normal" },
      { name: "LspointsDiagnosticsSignHint", linksto: "Normal" },
    ] satisfies HighlightParam[];
    await setHighlights(denops, highlights);
  }

  async publish(
    denops: Denops,
    clientName: string,
    bufnr: number,
    diags: LSP.Diagnostic[],
    signal: AbortSignal,
  ) {
    const icon = {
      error: "E>",
      warning: "W>",
      hint: "H>",
      information: "I>",
    } as Record<SeverityString, string>;
    const signs = severityString.map((severity) => {
      return {
        name: `lspoints.extension.diagnostics.sign.${clientName}.${severity}`,
        text: icon[severity],
        texthl: `LspointsDiagnosticsSign${capitalize(severity)}`,
      };
    });

    const placesSet = {
      error: new Set(),
      warning: new Set(),
      information: new Set(),
      hint: new Set(),
    } as Record<SeverityString, Set<number>>;
    for (const diag of diags) {
      const severity = getSeverityString(
        diag.severity ?? LSP.DiagnosticSeverity.Error,
      );
      placesSet[severity].add(diag.range.start.line);
    }

    const group = `lspoints.extension.diagnostics.sign.${clientName}`;
    const places = [] as {
      buffer: number;
      group: string;
      lnum: number;
      name: string;
    }[];
    const added = new Set();
    for (const severity of severityString) {
      const name = `${group}.${severity}`;
      for (const line of placesSet[severity].values()) {
        if (added.has(line)) {
          continue;
        }
        added.add(line);
        places.push({
          buffer: bufnr,
          group,
          lnum: line,
          name,
        });
      }
    }

    if (signal.aborted) {
      return;
    }

    await batch(denops, async (denops) => {
      await fn.sign_unplace(
        denops,
        `lspoints.extension.diagnostics.sign.${clientName}`,
        { buffer: bufnr },
      );
      if (places.length !== 0) {
        await fn.sign_define(denops, signs);
        await fn.sign_placelist(denops, places);
      }
      await denops.redraw();
    });
  }
}

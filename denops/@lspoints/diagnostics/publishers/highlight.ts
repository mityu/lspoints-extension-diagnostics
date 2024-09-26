import type { Denops } from "jsr:@denops/std@^7.1.0";
import { batch } from "jsr:@denops/std@^7.1.0/batch";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import {
  capitalize,
  DiagnosticsPublisher,
  getSeverityString,
  SeverityString,
  severityString,
} from "../internals.ts";
import * as textprop from "jsr:@mityu/lspoints-toolkit@^0.1.1/textprop";
import {
  defineDefaultLinks,
  HighlightLinkParams,
} from "jsr:@mityu/lspoints-toolkit@^0.1.1/highlight";

export class HighlightPublisher implements DiagnosticsPublisher {
  async initialize(denops: Denops) {
    const highlights = [
      ["LspointsDiagnosticsHighlightError", "Error"],
      ["LspointsDiagnosticsHighlightWarning", "WarningMsg"],
      ["LspointsDiagnosticsHighlightInformation", "Normal"],
      ["LspointsDiagnosticsHighlightHint", "Normal"],
    ] satisfies HighlightLinkParams;
    await defineDefaultLinks(denops, highlights);
  }

  async publish(
    denops: Denops,
    clientName: string,
    bufnr: number,
    diags: LSP.Diagnostic[],
    signal: AbortSignal,
  ) {
    const types = severityString.map(
      (severity) => {
        const propType =
          `lspoints.extension.diagnostics.highlight.${clientName}.${severity}`;
        const highlight = `LspointsDiagnosticsHighlight${capitalize(severity)}`;
        return {
          name: propType,
          highlight: highlight,
        } satisfies textprop.TextPropTypeConfig;
      },
    );

    const propsSet = {
      error: [],
      warning: [],
      information: [],
      hint: [],
    } as Record<SeverityString, textprop.Highlight[]>;
    for (const diag of diags) {
      const severity = diag.severity ?? LSP.DiagnosticSeverity.Error;
      propsSet[getSeverityString(severity)].push(diag.range);
    }

    // Get textprop groups to clear.
    const leading = `lspoints.extension.diagnostics.highlight.${clientName}`;
    const clearTargets = (await textprop.getTypes(denops)).filter((v) =>
      v.startsWith(leading)
    );

    if (signal.aborted) {
      return;
    }

    await batch(denops, async (denops) => {
      await textprop.clearByTypes(denops, bufnr, clearTargets);
      if (Object.values(propsSet).findIndex((v) => v.length !== 0) !== -1) {
        // Add highlights only when there're any entries.
        await textprop.addTypes(denops, types);
        for (const severity of severityString) {
          const type =
            `lspoints.extension.diagnostics.highlight.${clientName}.${severity}`;
          await textprop.addHighlights(denops, bufnr, type, propsSet[severity]);
        }
      }
      await denops.redraw();
    });
  }
}

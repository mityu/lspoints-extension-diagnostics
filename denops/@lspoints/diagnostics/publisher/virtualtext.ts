import type { Denops } from "jsr:@denops/std@^7.1.0";
import { batch } from "jsr:@denops/std@^7.1.0/batch";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import * as textprop from "jsr:@mityu/lspoints-toolkit@^0.1.2/textprop";
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

export class VirtualTextPublisher implements DiagnosticsPublisher {
  async initialize(denops: Denops) {
    const highlights = [
      { name: "LspointsDiagnosticsVirtualTextError", linksto: "Error" },
      { name: "LspointsDiagnosticsVirtualTextWarning", linksto: "WarningMsg" },
      { name: "LspointsDiagnosticsVirtualTextInformation", linksto: "Normal" },
      { name: "LspointsDiagnosticsVirtualTextHint", linksto: "Normal" },
    ] satisfies HighlightParam[];
    await setHighlights(denops, highlights);
  }

  async publish(
    denops: Denops,
    clientName: string,
    bufnr: number,
    diagsAll: LSP.Diagnostic[],
    signal: AbortSignal,
  ) {
    const diags = diagsAll.filter((diag) => diag.message);

    const types = severityString.map(
      (severity, idx) => {
        const typeName =
          `lspoints.extension.diagnostics.virtualtext.${clientName}.${severity}`;
        const highlight = `LspointsDiagnosticsVirtualText${
          capitalize(severity)
        }`;
        const priority = severityString.length - idx - 1;
        return {
          name: typeName,
          highlight: highlight,
          priority: {
            vim: priority,
            nvim: priority + 100,
          },
        } satisfies textprop.TextPropTypeConfig;
      },
    );

    const virtTextsSet = {
      error: [],
      warning: [],
      information: [],
      hint: [],
    } as Record<SeverityString, textprop.VirtualText[]>;
    for (const diag of diags) {
      const severity = diag.severity ?? LSP.DiagnosticSeverity.Error;
      const severityString = getSeverityString(severity);
      virtTextsSet[severityString].push({
        line: diag.range.start.line,
        column: 0,
        text: diag.message.replace(/\n/g, " "),
        textPos: "right_align",
        textPaddingLeft: 2,
        textWrap: "truncate",
      });
    }

    if (signal.aborted) {
      return;
    }

    // Get virtual text entries to show.  We only show one diagnostic on a
    // line.
    const placedLines = new Set<number>(); // Hold line numbers where virtual texts are published.
    const virtTexts = severityString.reduce((acc, severity) => {
      const type =
        `lspoints.extension.diagnostics.virtualtext.${clientName}.${severity}`;
      const entries = virtTextsSet[severity].filter((v) => {
        if (placedLines.has(v.line)) {
          return false;
        }
        placedLines.add(v.line);
        return true;
      });
      acc.push([type, entries]);
      return acc;
    }, [] as [string, textprop.VirtualText[]][]);

    // Get textprop group names to clear.
    const leading = `lspoints.extension.diagnostics.virtualtext.${clientName}`;
    const clearTargets = (await textprop.getTypes(denops)).filter((v) =>
      v.startsWith(leading)
    );

    if (signal.aborted) {
      return;
    }

    await batch(denops, async (denops) => {
      await textprop.clearByTypes(denops, bufnr, clearTargets);
      if (virtTexts.findIndex(([_, v]) => v.length !== 0) !== -1) {
        // Add virtual-texts only when there're any entries.
        await textprop.addTypes(denops, types);
        for (const [type, toPublish] of virtTexts) {
          await textprop.addVirtualTexts(denops, bufnr, type, toPublish);
        }
      }
      await denops.redraw();
    });
  }
}

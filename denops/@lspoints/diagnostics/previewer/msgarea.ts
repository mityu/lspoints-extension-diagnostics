import type { Denops } from "jsr:@denops/std@^7.1.0";
import type {
  DiagnosticPreviewOptions,
  DiagnosticsPreviewer,
} from "../internals.ts";
import type { Diagnostic } from "npm:vscode-languageserver-protocol@^3.17.5";
import { strdisplaywidth } from "jsr:@denops/std@^7.1.0/function";
import { columns } from "jsr:@denops/std@^7.1.0/option";
import { echo } from "jsr:@mityu/lspoints-toolkit@^0.1.2/echo";

async function clampMessageWidth(
  denops: Denops,
  message: string,
  maxWidth: number,
): Promise<string> {
  if (await strdisplaywidth(denops, message) < maxWidth) {
    return message;
  }

  const region = { bottom: 0, top: message.length };
  for (;;) {
    const len = region.bottom + Math.ceil((region.top - region.bottom) / 2);
    const text = message.substring(0, len);
    if (await strdisplaywidth(denops, text) < maxWidth) {
      region.bottom = len;
    } else {
      region.top = len - 1;
    }
    if (region.top <= region.bottom) {
      return message.substring(0, region.bottom);
    }
  }
}

export class Previewer implements DiagnosticsPreviewer {
  async show(
    denops: Denops,
    diagnostic: Diagnostic,
    opts: DiagnosticPreviewOptions,
  ) {
    if (!diagnostic?.message) {
      if (!opts.silent) {
        switch (opts.kind) {
          case "atCursor":
            await echo(denops, "No diagnostics found at cursor.", {
              highlight: "WarningMsg",
            });
            break;
          case "onLine":
            await echo(denops, "No diagnostics found on line.", {
              highlight: "WarningMsg",
            });
            break;
          default:
            opts.kind satisfies never;
        }
      }
      return;
    }

    const message = diagnostic.message.replace(/\r|\n/g, " ");
    const scWidth = await columns.get(denops);
    await echo(denops, await clampMessageWidth(denops, message, scWidth));
  }
}

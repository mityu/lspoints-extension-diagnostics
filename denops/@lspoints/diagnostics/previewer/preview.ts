import type { Denops } from "jsr:@denops/std@^7.1.0";
import { batch } from "jsr:@denops/std@^7.1.0/batch";
import type {
  DiagnosticPreviewOptions,
  DiagnosticsPreviewer,
} from "../internals.ts";
import type { Diagnostic } from "npm:vscode-languageserver-protocol@^3.17.5";
import * as fn from "jsr:@denops/std@^7.1.0/function";
import { echo } from "jsr:@mityu/lspoints-toolkit@^0.1.2/echo";

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
    const text = diagnostic.message.split(/\r?\n/);

    await denops.cmd("silent! pedit lspoints://diagnostic-message-preview");
    const bufnr = await fn.bufnr(
      denops,
      "lspoints://diagnostic-message-preview",
    );
    const winid = await fn.bufwinid(denops, bufnr);

    await batch(denops, async (denops) => {
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&bufhidden", "delete");
      await fn.deletebufline(denops, bufnr, 1, "$");
      await fn.setbufline(denops, bufnr, 1, text);
      await fn.win_execute(denops, winid, "call cursor(1, 1)");
      await denops.redraw();
    });
  }
}

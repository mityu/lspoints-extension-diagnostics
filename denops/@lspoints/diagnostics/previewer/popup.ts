import type { Denops } from "jsr:@denops/std@^7.1.0";
import type { Diagnostic } from "npm:vscode-languageserver-protocol@^3.17.5";
import type {
  DiagnosticPreviewOptions,
  DiagnosticsPreviewer,
} from "../internals.ts";
import {
  openPreviewPopup,
  type PreviewPopup,
} from "jsr:@mityu/lspoints-toolkit@^0.1.2/popup";
import { echo } from "jsr:@mityu/lspoints-toolkit@^0.1.2/echo";

export class Previewer implements DiagnosticsPreviewer {
  #popup?: PreviewPopup;

  async show(
    denops: Denops,
    diagnostic: Diagnostic,
    opts: DiagnosticPreviewOptions,
  ) {
    await this.#popup?.close();

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

    this.#popup = await openPreviewPopup(denops, {
      contents: diagnostic.message.split(/\r?\n/),
      line: 1,
      col: 0,
      pos: "topleft",
      moved: "any",
      border: "double",
    });
  }
}

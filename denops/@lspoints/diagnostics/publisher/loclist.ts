import type { Denops } from "jsr:@denops/std@^7.1.0";
import { execute } from "jsr:@denops/std@^7.1.0/helper/execute";
import { ensure } from "jsr:@core/unknownutil@^4.3.0/ensure";
import { is } from "jsr:@core/unknownutil@^4.3.0/is";
import { ulid } from "jsr:@std/ulid@^1.0.0/ulid";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import { type DiagnosticsPublisher } from "../internals.ts";

const severityIcon: Record<LSP.DiagnosticSeverity, string> = {
  1: "E",
  2: "W",
  3: "I",
  4: "N",
};

const cacheKey = "lspoints-extension-diagnostics/publisher/loclist.ts@0";

export type LocItem = {
  bufnr: number;
  lnum: number;
  col: number;
  end_lnum: number;
  end_col: number;
  text: string;
  type: string;
};

export function toLocItem(bufnr: number, d: LSP.Diagnostic): LocItem {
  return {
    bufnr,
    lnum: d.range.start.line,
    col: d.range.start.character,
    end_lnum: d.range.end.line,
    end_col: d.range.end.character,
    text: d.message,
    type: severityIcon[d.severity ?? LSP.DiagnosticSeverity.Error],
  };
}

export function compareLocItem(a: LocItem, b: LocItem): number {
  if (a.lnum != b.lnum) {
    return a.lnum - b.lnum;
  } else {
    return a.col - b.col;
  }
}

async function ensureSetter(denops: Denops): Promise<string> {
  if (is.String(denops.context[cacheKey])) {
    return denops.context[cacheKey];
  }
  const suffix = ulid();
  const fnName = `LspointsExtensionDiagnosticsSetLoclist_${suffix}`;
  denops.context[cacheKey] = fnName;

  const script = `
  function! ${fnName}(bufnr, locid, items) abort
    let winid = 0
    if bufnr() != a:bufnr
      let winid = bufwinid(a:bufnr)
      if winid == -1
        return 0
      endif
    endif

    let cur_id = getloclist(winid, {'id': 0}).id
    if cur_id == a:locid
      " Current location list is the lspoints' diagnostics.  Replace it.
      call setloclist(winid, [], 'r', {'id': a:locid, 'title': 'lspoints diagnostics', 'items': a:items})
    else
      " Current location list is others'.  Create new location list.
      call setloclist(winid, [], ' ', {'title': 'lspoints diagnostics', 'items': a:items})
    endif
    return getloclist(winid, {'id': 0}).id
  endfunction
  `;
  await execute(denops, script);
  return fnName;
}

export class LoclistPublisher implements DiagnosticsPublisher {
  #diagnostics: Map<number, Map<string, LocItem[]>> = new Map();
  #loclistId: number = 0;

  initialize(_: Denops) {
    return Promise.resolve();
  }

  async publish(
    denops: Denops,
    clientName: string,
    bufnr: number,
    diags: LSP.Diagnostic[],
    signal: AbortSignal,
  ) {
    if (!this.#diagnostics.has(bufnr)) {
      this.#diagnostics.set(bufnr, new Map());
    }

    const newItems = diags.map((d) => toLocItem(bufnr, d)).sort(compareLocItem);

    const bufferDiags = this.#diagnostics.get(bufnr)!;
    bufferDiags.set(clientName, newItems);

    if (signal.aborted) {
      return;
    }

    const locitems = Array.from(bufferDiags.values()).flat().sort(
      compareLocItem,
    );

    if (signal.aborted) {
      return;
    }

    const fn = await ensureSetter(denops);
    this.#loclistId = ensure(
      await denops.call(fn, bufnr, this.#loclistId, locitems),
      is.Number,
    );
  }
}

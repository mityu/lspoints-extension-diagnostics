import type { Denops } from "jsr:@denops/std@^7.1.0";
import { BaseExtension, type Lspoints } from "jsr:@kuuote/lspoints@^0.1.1";
import { collect } from "jsr:@denops/std@^7.1.0/batch";
import * as autocmd from "jsr:@denops/std@^7.1.0/autocmd";
import * as lambda from "jsr:@denops/std@^7.1.0/lambda";
import * as fn from "jsr:@denops/std@^7.1.0/function";
import * as LSP from "npm:vscode-languageserver-protocol@^3.17.5";
import { assert } from "jsr:@core/unknownutil@^4.3.0/assert";
import { as } from "jsr:@core/unknownutil@^4.3.0/as";
import { is } from "jsr:@core/unknownutil@^4.3.0/is";
import { ensure } from "jsr:@core/unknownutil@^4.3.0/ensure";
import type { PredicateType } from "jsr:@core/unknownutil@^4.3.0/type";
import { zip } from "jsr:@core/iterutil@^0.8.0/zip";
import { map } from "jsr:@core/iterutil@^0.8.0/map";
import { uriToFname } from "jsr:@uga-rosa/denops-lsputil@^0.9.4/uri";
import {
  createPosition,
  isPositionBefore,
} from "jsr:@uga-rosa/denops-lsputil@^0.9.4/util";
import { toVimRanges } from "jsr:@mityu/lspoints-toolkit@^0.1.2/to-vim-ranges";
import {
  DiagnosticsPreviewer,
  DiagnosticsPublisher,
  SeverityString,
} from "./diagnostics/internals.ts";
import { SignPublisher } from "./diagnostics/publisher/sign.ts";
import { HighlightPublisher } from "./diagnostics/publisher/highlight.ts";
import { VirtualTextPublisher } from "./diagnostics/publisher/virtualtext.ts";
import {
  compareLocItem,
  LoclistPublisher,
  toLocItem,
} from "./diagnostics/publisher/loclist.ts";
import { Previewer as MsgareaPreviewer } from "./diagnostics/previewer/msgarea.ts";
import { Previewer as PopupPreviewer } from "./diagnostics/previewer/popup.ts";
import { Previewer as PreviewPreviewer } from "./diagnostics/previewer/preview.ts";

const isShowOptions = is.ObjectOf({
  silent: as.Optional(is.Boolean),
  previewer: as.Optional(
    is.LiteralOneOf(["msgarea", "popup", "preview"] as const),
  ),
  kind: as.Optional(is.LiteralOneOf(["atCursor", "onLine"] as const)),
});

export type ShowOptions = PredicateType<typeof isShowOptions>;

type PublisherKind = "highlight" | "virtualtext" | "sign" | "loclist";

function countDiagnostics(
  diags: LSP.Diagnostic[],
): Record<SeverityString, number> {
  const count = diags.map((d) => {
    return d.severity ?? LSP.DiagnosticSeverity.Error;
  }).reduce(
    (acc, severity) => {
      acc[severity]++;
      return acc;
    },
    { 1: 0, 2: 0, 3: 0, 4: 0 } satisfies Record<
      LSP.DiagnosticSeverity,
      number
    >,
  );
  return {
    error: count[LSP.DiagnosticSeverity.Error],
    warning: count[LSP.DiagnosticSeverity.Warning],
    information: count[LSP.DiagnosticSeverity.Information],
    hint: count[LSP.DiagnosticSeverity.Hint],
  } satisfies Record<SeverityString, number>;
}

// Get the "most important" diagnostic in line where "most important" mean
// - whose severity number is the smallest in all the diagnostics in line
// - whose range.start points the most formar position in all the diagnostics in line
function getToplevelDiagnosticInLine(
  diags: LSP.Diagnostic[],
  line: number,
): LSP.Diagnostic | undefined {
  return diags.filter((diag) =>
    diag.range.start.line <= line && line <= diag.range.end.line
  ).reduce(
    (acc, diag) => {
      if (!acc) {
        return diag;
      }
      const accSeverity = acc.severity ?? LSP.DiagnosticSeverity.Error;
      const diagSeverity = diag.severity ?? LSP.DiagnosticSeverity.Error;
      if (
        accSeverity < diagSeverity ||
        (accSeverity === diagSeverity &&
          isPositionBefore(acc.range.start, diag.range.start, true))
      ) {
        return acc;
      }
      return diag;
    },
    undefined as LSP.Diagnostic | undefined,
  );
}

function getDiagnosticAt(
  diags: LSP.Diagnostic[],
  pos: LSP.Position,
): LSP.Diagnostic | undefined {
  const initValue = undefined as ReturnType<typeof getDiagnosticAt>;
  const diag = diags.filter((diag) =>
    isPositionBefore(diag.range.start, pos, true) &&
    isPositionBefore(pos, diag.range.end)
  ).reduce((acc, diag) => {
    if (acc && isPositionBefore(diag.range.start, acc.range.start)) {
      return acc;
    }
    return diag;
  }, initValue);

  if (diag) {
    return diag;
  }

  // There must be no diagnostic whose range covers the cursor position.  Next,
  // search for the diagnostics placed previous position to the cursor.
  const diagBefore = diags.reduce((acc, diag) => {
    if (
      diag.range.start.line !== pos.line ||
      diag.range.start.character > pos.character
    ) {
      return acc;
    }
    if (acc && isPositionBefore(diag.range.start, acc.range.start)) {
      return acc;
    }
    return diag;
  }, initValue);

  if (diagBefore) {
    return diagBefore;
  }

  // Lastly, search for the diagnostics placed after the cursor.
  return diags.reduce((acc, diag) => {
    if (
      diag.range.start.line !== pos.line ||
      (acc && isPositionBefore(acc.range.start, diag.range.start))
    ) {
      return acc;
    }
    return diag;
  }, initValue);
}

class PublishController {
  #publisher: DiagnosticsPublisher;
  #enabled: boolean;
  #abortControllers: Map<
    string, // clientName + bufnr
    { abortController: AbortController; promise: Promise<void> }
  >;

  constructor(publisher: DiagnosticsPublisher) {
    this.#publisher = publisher;
    this.#enabled = false;
    this.#abortControllers = new Map();
  }

  enable() {
    this.#enabled = true;
  }

  disable() {
    this.#enabled = false;
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  async initialize(denops: Denops) {
    await this.#publisher.initialize(denops);
  }

  async publish(
    denops: Denops,
    clientName: string,
    bufnr: number,
    diags: LSP.Diagnostic[],
  ) {
    const publishKey = `${clientName}${bufnr}`;
    const prevCall = this.#abortControllers.get(publishKey);
    if (prevCall) {
      // Cancel ongoing previous publish call.
      prevCall.abortController.abort();
      await prevCall.promise; // Wait until publish process is aborted.
    }

    const abortController = new AbortController();
    const promise = this.#publisher.publish(
      denops,
      clientName,
      bufnr,
      diags,
      abortController.signal,
    )
      .finally(() => {
        this.#abortControllers.delete(publishKey);
      });
    this.#abortControllers.set(publishKey, { abortController, promise });
    await promise;
  }

  async clear(denops: Denops, clientName: string, bufnr: number) {
    await this.publish(denops, clientName, bufnr, []);
  }
}

export class Extension extends BaseExtension {
  #diagnostics: Map<string, Map<number, LSP.Diagnostic[]>> = new Map();
  #publishers: Record<PublisherKind, PublishController> = {
    highlight: new PublishController(new HighlightPublisher()),
    virtualtext: new PublishController(new VirtualTextPublisher()),
    sign: new PublishController(new SignPublisher()),
    loclist: new PublishController(new LoclistPublisher()),
  };
  #previewers: Record<
    NonNullable<ShowOptions["previewer"]>,
    DiagnosticsPreviewer
  > = {
    msgarea: new MsgareaPreviewer(),
    popup: new PopupPreviewer(),
    preview: new PreviewPreviewer(),
  };

  async initialize(denops: Denops, lspoints: Lspoints) {
    const onReopen = lambda.add(denops, async (bufnr: unknown) => {
      await this.#onReopenBuffer(denops, bufnr);
    });
    const extractBufnr = async (bufnr: unknown | undefined) => {
      if (bufnr == undefined) {
        return await fn.bufnr(denops);
      } else {
        return ensure(bufnr, is.Number);
      }
    };
    const buildEnabler = (kind: PublisherKind) => {
      return this.#buildEnabler(denops, kind);
    };
    const buildDisabler = (kind: PublisherKind) => {
      return this.#buildDisabler(denops, kind);
    };

    for (const publisher of Object.values(this.#publishers)) {
      await publisher.initialize(denops);
    }

    lspoints.subscribeNotify(
      "textDocument/publishDiagnostics",
      async (clientName, untypedParams) => {
        await this.#onPublishDiagnostics(denops, clientName, untypedParams);
      },
    );

    lspoints.subscribeAttach(async (_clientName, bufnr) => {
      await this.#onAttach(denops, onReopen, bufnr);
    });

    lspoints.subscribeDetach(async (clientName) => {
      await this.#onDetach(denops, lspoints, clientName);
    });

    lspoints.defineCommands("diagnostics", {
      enableAutoHighlight: buildEnabler("highlight"),
      disableAutoHighlight: buildDisabler("highlight"),
      enableAutoVirtualText: buildEnabler("virtualtext"),
      disableAutoVirtualText: buildDisabler("virtualtext"),
      enableAutoSign: buildEnabler("sign"),
      disableAutoSign: buildDisabler("sign"),
      enableAutoLoclist: buildEnabler("loclist"),
      disableAutoLoclist: buildDisabler("loclist"),
      show: async (options: unknown = {}) => {
        assert(options, isShowOptions);
        const [bufnr, line, col] = ensure(
          await collect(denops, (denops) => [
            fn.bufnr(denops),
            fn.line(denops, "."),
            fn.col(denops, "."),
          ]),
          is.TupleOf([is.Number, is.Number, is.Number]),
        );

        const kind = options.kind ?? "atCursor";
        const diag = (() => {
          const diags = Object.values(this.#getDiagnosticsForBuffer(bufnr))
            .flat();
          switch (kind) {
            case "atCursor":
              return getDiagnosticAt(diags, createPosition(line, col));
            case "onLine":
              return getToplevelDiagnosticInLine(diags, line);
            default:
              kind satisfies never;
          }
        })();

        const previewerType = options.previewer ?? "msgarea";
        const previewer = this.#previewers[previewerType];
        await previewer.show(denops, diag, {
          silent: options.silent ?? false,
          previewer: previewerType,
          kind,
        });
      },
      setLoclist: async () => {
        const bufnr = await fn.bufnr(denops);
        const bufDiags = this.#getDiagnosticsForBuffer(bufnr);
        const items = Object.values(bufDiags).flat().map((d) =>
          toLocItem(bufnr, d)
        ).sort(compareLocItem);
        await fn.setloclist(denops, 0, [], " ", {
          items,
          title: "lspoints diagnostics",
        });
      },
      get: async (bufnrGiven: unknown = undefined) => {
        const bufnr = await extractBufnr(bufnrGiven);
        return this.#getDiagnosticsForBuffer(bufnr);
      },
      getFlat: async (bufnrGiven: unknown = undefined) => {
        const bufnr = await extractBufnr(bufnrGiven);
        return Object.values(this.#getDiagnosticsForBuffer(bufnr)).flat();
      },
      getCount: async (bufnrGiven: unknown = undefined) => {
        const bufnr = await extractBufnr(bufnrGiven);
        const diags = this.#getDiagnosticsForBuffer(bufnr);
        return Object.entries(diags).reduce((acc, [k, v]) => {
          acc[k] = countDiagnostics(v);
          return acc;
        }, {} as Record<string, ReturnType<typeof countDiagnostics>>);
      },
      getCountFlat: async (bufnrGiven: unknown = undefined) => {
        const bufnr = await extractBufnr(bufnrGiven);
        const diags = this.#getDiagnosticsForBuffer(bufnr);
        return countDiagnostics(Object.values(diags).flat());
      },
    });
  }

  async #onPublishDiagnostics(
    denops: Denops,
    clientName: string,
    untypedParams: unknown,
  ) {
    const params = untypedParams as LSP.PublishDiagnosticsParams;
    const bufnr = await fn.bufnr(denops, uriToFname(params.uri));
    if (bufnr == -1) {
      return;
    }

    // Convert diagnostics' ranges into Vim's ones.
    const ranges = await toVimRanges(
      denops,
      bufnr,
      params.diagnostics.map((d) => d.range),
    );
    const diagnostics = Array.from(
      map(zip(params.diagnostics, ranges), ([d, r]) => {
        return { ...d, range: r } satisfies LSP.Diagnostic;
      }),
    );

    if (!this.#diagnostics.has(clientName)) {
      this.#diagnostics.set(clientName, new Map());
    }
    if (diagnostics.length == 0) {
      this.#diagnostics.get(clientName)!.delete(bufnr);
    } else {
      this.#diagnostics.get(clientName)!.set(bufnr, diagnostics);
    }

    // Publish diagnostics somehow if enabled.
    const promises = [] as Promise<void>[];
    for (const publisher of Object.values(this.#publishers)) {
      if (publisher.isEnabled()) {
        promises.push(
          publisher.publish(denops, clientName, bufnr, diagnostics),
        );
      }
    }
    await Promise.all(promises);
  }

  async #onAttach(
    denops: Denops,
    onReopen: lambda.Lambda,
    bufnr: number,
  ) {
    await autocmd.group(
      denops,
      "lspoints.extension.diagnostics",
      (helper) => {
        helper.remove("BufWinEnter", `<buffer=${bufnr}>`);
        helper.define(
          "BufWinEnter",
          `<buffer=${bufnr}>`,
          `call denops#notify('${denops.name}', '${onReopen.id}', [${bufnr}])`,
          {
            nested: true,
          },
        );
      },
    );
  }

  async #onDetach(denops: Denops, lspoints: Lspoints, clientName: string) {
    const bufnrs = lspoints.getClient(clientName)?.getAttachedBufNrs();
    if (bufnrs) {
      const promises = [] as Promise<void>[];
      for (const bufnr of bufnrs) {
        // Clear diagnostics.
        for (const publisher of Object.values(this.#publishers)) {
          if (publisher.isEnabled()) {
            promises.push(publisher.clear(denops, clientName, bufnr));
          }
        }

        // Remove autocmds to detect reopen of file if no other lsp servers are
        // attached to the buffer.
        if (lspoints.getClients(bufnr).length <= 1) {
          promises.push(
            autocmd.remove(denops, "BufWinEnter", `<buffer=${bufnr}>`, {
              group: "lspoints.extension.diagnostics",
            }),
          );
        }
      }
      await Promise.all(promises);
    }
    this.#diagnostics.delete(clientName);
  }

  async #onReopenBuffer(denops: Denops, bufnr: unknown) {
    assert(bufnr, is.Number);

    // Re-publish diagnostics on buffer.
    const diags = this.#getDiagnosticsForBuffer(bufnr);
    const promises = [] as Promise<void>[];
    Object.entries(diags).forEach(([clientName, diags]) => {
      Object.values(this.#publishers).forEach((publisher) => {
        if (publisher.isEnabled()) {
          promises.push(publisher.publish(denops, clientName, bufnr, diags));
        }
      });
    });
    await Promise.all(promises);
  }

  #getDiagnosticsForBuffer(bufnr: number): Record<string, LSP.Diagnostic[]> {
    const diagnostics = {} as Record<string, LSP.Diagnostic[]>;
    this.#diagnostics.forEach((clientDiags, clientName) => {
      clientDiags.forEach((diags, diagBufnr) => {
        if (bufnr === diagBufnr) {
          diagnostics[clientName] = diags;
        }
      });
    });
    return diagnostics;
  }

  #buildEnabler(denops: Denops, kind: PublisherKind): () => Promise<void> {
    return async () => {
      const publisher = this.#publishers[kind];
      if (!publisher.isEnabled()) {
        // First, send request for the publisher to publishing diagnostics
        // using existing entries.
        const promises = [] as Promise<void>[];
        for (const [clientName, diagsSet] of this.#diagnostics.entries()) {
          for (const [bufnr, diags] of diagsSet.entries()) {
            promises.push(
              publisher.publish(denops, clientName, bufnr, diags),
            );
          }
        }

        // Then, set enable flag to make the publisher accept diagnostics
        // updates from LSP server.
        publisher.enable();

        // Lastly, wait for all the requests finish.
        await Promise.all(promises);
      }
    };
  }

  #buildDisabler(denops: Denops, kind: PublisherKind): () => Promise<void> {
    return async () => {
      const publisher = this.#publishers[kind];
      if (publisher.isEnabled()) {
        // Set disable flag first in order not to next diagnostics are
        // published while doing this diagnostics cleanup.
        publisher.disable();

        const promises = [] as Promise<void>[];
        for (const [name, nd] of this.#diagnostics.entries()) {
          for (const bufnr of nd.keys()) {
            promises.push(publisher.clear(denops, name, bufnr));
          }
        }
        await Promise.all(promises);
      }
    };
  }
}

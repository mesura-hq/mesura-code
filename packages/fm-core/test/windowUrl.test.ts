import { describe, expect, it } from "vitest";

import { homeFromSearch, homeQuery, pickerFromSearch, pickerQuery } from "../src/windowUrl.ts";

/**
 * The two ends of one agreement between two processes.
 *
 * The main process builds the query and the sandboxed renderer reads it, and
 * neither can import the other. Review found that a typo in the parameter name
 * on either side would break the tilde with nothing to catch it: the failure is
 * a key that is simply absent, which is indistinguishable from a window that
 * was never told where home is. Both ends now come from this module, so the
 * round trip below is the whole contract.
 */
describe("the home directory on the window URL", () => {
  it("comes back exactly as it went in", () => {
    expect(homeFromSearch(homeQuery("/home/jc"))).toBe("/home/jc");
  });

  it("survives a space", () => {
    expect(homeFromSearch(homeQuery("/home/jc/My Files"))).toBe("/home/jc/My Files");
  });

  it("survives a plus", () => {
    expect(homeFromSearch(homeQuery("/home/jc/c++"))).toBe("/home/jc/c++");
  });

  it("reads a LITERAL plus in the URL as a plus, not as a space", () => {
    // The reason `URLSearchParams` is not used here, and it has to be asserted
    // against a hand-written URL rather than a round trip. `encodeURIComponent`
    // escapes `+` to `%2B`, so a URL this module wrote never contains a literal
    // one — the round-trip test above passes under form decoding too, and did.
    //
    // A URL this module did NOT write is where the difference appears: the HTML
    // form encoding reads `+` as a space, so `/home/jc/c+lang` would arrive as
    // `/home/jc/c lang` and the tilde would go somewhere that does not exist.
    expect(homeFromSearch("?home=/home/jc/c+lang")).toBe("/home/jc/c+lang");
  });

  it("survives characters outside ASCII", () => {
    expect(homeFromSearch(homeQuery("/home/jc/Música/日本"))).toBe("/home/jc/Música/日本");
  });

  it("survives an ampersand, which would otherwise start a second parameter", () => {
    expect(homeFromSearch(homeQuery("/home/jc/a&b=c"))).toBe("/home/jc/a&b=c");
  });
});

describe("a window that was told nothing usable", () => {
  it("falls back to the root when there is no query at all", () => {
    expect(homeFromSearch("")).toBe("/");
  });

  it("falls back when the query carries other parameters but not this one", () => {
    expect(homeFromSearch("?theme=dark&debug=1")).toBe("/");
  });

  it("falls back when the value is not an absolute path", () => {
    // A relative path would send the tilde somewhere the pane cannot list, and
    // the window would look broken rather than merely unconfigured.
    expect(homeFromSearch("?home=not-a-path")).toBe("/");
  });

  it("falls back rather than throwing on a malformed escape", () => {
    // `decodeURIComponent` throws on `%zz`. A URL is external input the moment
    // anything else can set it, and a throw here would take the whole render
    // down over one stray character.
    expect(() => homeFromSearch("?home=%zz")).not.toThrow();
    expect(homeFromSearch("?home=%zz")).toBe("/");
  });

  it("reads the parameter whether or not the leading question mark is there", () => {
    // `window.location.search` includes it; a caller slicing a URL by hand
    // might not.
    expect(homeFromSearch("home=%2Ftmp")).toBe("/tmp");
    expect(homeFromSearch("?home=%2Ftmp")).toBe("/tmp");
  });

  it("does not match a parameter whose name merely ends in the same letters", () => {
    // `homeFromSearch` compares the whole key. A prefix match would read
    // `oldhome` as `home` and send the tilde to the wrong place.
    expect(homeFromSearch("?oldhome=%2Ftmp")).toBe("/");
  });
});

describe("the picker request a window carries", () => {
  it("round-trips every option through the URL", () => {
    // The renderer needs these at FIRST RENDER: a dialog that paints as an
    // ordinary browse window and then becomes a picker is visible, and a
    // request over the bridge would arrive a frame or two late. The window URL
    // is the mechanism already established for exactly this — see `homeQuery`.
    const request = {
      fifo: "/tmp/symmetria-picker-abc.fifo",
      options: {
        title: "Save your download",
        acceptLabel: "Save",
        multiple: false,
        directory: false,
        saveMode: true,
        suggestedName: "report.pdf",
        currentFolder: "/home/jc/Downloads",
      },
    } as const;

    expect(pickerFromSearch(pickerQuery(request))).toEqual(request);
  });

  it("survives a directory whose name would confuse a form decoder", () => {
    // `URLSearchParams` is not used here and this is why: its parser is the
    // HTML form encoding, which decodes `+` as a space, so a directory named
    // `c++` comes back as `c  `. The same trap `homeFromSearch` documents.
    const request = {
      fifo: "/tmp/symmetria-picker-abc.fifo",
      options: {
        title: "Pick a file from c++ & friends",
        acceptLabel: "",
        multiple: true,
        directory: false,
        saveMode: false,
        suggestedName: "",
        currentFolder: "/home/jc/code/c++",
      },
    } as const;

    expect(pickerFromSearch(pickerQuery(request))).toEqual(request);
  });

  it("reports no picker for a window that is not one", () => {
    // The browse window carries only the home query, and it must not be
    // mistaken for a dialog with every option defaulted.
    expect(pickerFromSearch("?home=%2Fhome%2Fjc")).toBe(null);
    expect(pickerFromSearch("")).toBe(null);
  });

  it("reports no picker rather than throwing on a malformed value", () => {
    // A URL is external input the moment anything else can set it, and a throw
    // here would take the whole render down over a stray character.
    for (const search of ["?picker=%zz", "?picker=not-json", "?picker=%7B%7D", "?picker=[]"]) {
      expect(() => pickerFromSearch(search), search).not.toThrow();
      expect(pickerFromSearch(search), search).toBe(null);
    }
  });

  it("keeps the home query readable beside it", () => {
    // Both travel on the same URL and neither may eat the other.
    const request = {
      fifo: "/tmp/symmetria-picker-abc.fifo",
      options: {
        title: "t",
        acceptLabel: "",
        multiple: false,
        directory: true,
        saveMode: false,
        suggestedName: "",
        currentFolder: "",
      },
    } as const;
    const search = `${homeQuery("/home/jc")}&${pickerQuery(request).slice(1)}`;

    expect(homeFromSearch(search)).toBe("/home/jc");
    expect(pickerFromSearch(search)).toEqual(request);
  });
});

"use client";

/**
 * A writing box that shows formatted text, not HTML.
 *
 * The article body used to be a bare textarea full of <p> and <strong> tags,
 * which writers could neither read nor safely edit. Here they see the piece
 * as it will look and format it with a toolbar; the HTML is kept in a hidden
 * field under `name` and posted with the form. The server cleans it again on
 * save, so pasted Word or web content cannot carry scripts or styles in.
 */

import { useEffect, useRef, useState } from "react";

type Props = {
  name: string;
  /** Cleaned HTML to start from. */
  initial: string;
  /** The brand, for pictures uploaded into the text. */
  site: string;
  /** Where pictures in the text are stored. */
  imageFolder?: string;
  minHeight?: number;
};

const BLOCKS = [
  { value: "p", label: "Paragraph" },
  { value: "h2", label: "Heading" },
  { value: "h3", label: "Subheading" },
] as const;

export function RichEditor({ name, initial, site, imageFolder = "articles/images", minHeight = 420 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [block, setBlock] = useState("p");
  // Held in state, not written into the input by hand: React re-applies a
  // hidden input's default on every render, which emptied the posted text.
  const [html, setHtml] = useState(initial);

  // The starting text is put in once; React must not re-render over what the
  // writer is typing.
  useEffect(() => {
    if (box.current) {
      box.current.innerHTML = initial || "<p><br></p>";
      sync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sync() {
    if (box.current) {
      const now = box.current.innerHTML;

      setHtml(now === "<p><br></p>" || now === "<br>" ? "" : now);
    }
  }

  function run(command: string, value?: string) {
    box.current?.focus();
    document.execCommand(command, false, value);
    sync();
    noteBlock();
  }

  function noteBlock() {
    const current = String(document.queryCommandValue("formatBlock") || "p").toLowerCase().replace(/[<>]/g, "");

    setBlock(BLOCKS.some((b) => b.value === current) ? current : "p");
  }

  function addLink() {
    const url = window.prompt("Link address (https://…)");

    if (url) {
      run("createLink", /^(https?:|mailto:|\/)/i.test(url) ? url : `https://${url}`);
    }
  }

  async function addImage(file: File) {
    setBusy(true);
    setNote(null);

    const body = new FormData();

    body.set("site", site);
    body.set("folder", imageFolder);
    body.set("file", file);

    try {
      const response = await fetch("/api/dashboard/files", { method: "POST", body, headers: { accept: "application/json" } });
      const result = (await response.json()) as { ok: boolean; name?: string; message?: string };

      if (result.ok && result.name) {
        run("insertImage", `/api/public/${site}/files/${imageFolder}/${encodeURIComponent(result.name)}`);
        setNote({ bad: false, text: "Picture added. Save to keep it." });
      } else {
        setNote({ bad: true, text: result.message ?? "The picture could not be uploaded." });
      }
    } catch {
      setNote({ bad: true, text: "The picture could not be uploaded. Check the connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  // Buttons keep the selection: a mousedown on a toolbar button would
  // otherwise move focus out of the text and lose what was selected.
  const keep = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className="rte">
      <div className="rte-bar" role="toolbar" aria-label="Formatting">
        <select
          aria-label="Text style"
          value={block}
          onChange={(event) => {
            setBlock(event.target.value);
            run("formatBlock", event.target.value);
          }}
        >
          {BLOCKS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        <span className="rte-sep" />
        <button type="button" onMouseDown={keep} onClick={() => run("bold")} title="Bold (Ctrl+B)" aria-label="Bold">
          <b>B</b>
        </button>
        <button type="button" onMouseDown={keep} onClick={() => run("italic")} title="Italic (Ctrl+I)" aria-label="Italic">
          <i>I</i>
        </button>
        <button type="button" onMouseDown={keep} onClick={() => run("underline")} title="Underline (Ctrl+U)" aria-label="Underline">
          <u>U</u>
        </button>
        <span className="rte-sep" />
        <button type="button" onMouseDown={keep} onClick={() => run("insertUnorderedList")} title="Bulleted list" aria-label="Bulleted list">
          • List
        </button>
        <button type="button" onMouseDown={keep} onClick={() => run("insertOrderedList")} title="Numbered list" aria-label="Numbered list">
          1. List
        </button>
        <button type="button" onMouseDown={keep} onClick={() => run("formatBlock", "blockquote")} title="Quote" aria-label="Quote">
          ❝ Quote
        </button>
        <span className="rte-sep" />
        <button type="button" onMouseDown={keep} onClick={addLink} title="Add a link" aria-label="Add a link">
          🔗 Link
        </button>
        <button type="button" onMouseDown={keep} onClick={() => run("unlink")} title="Remove the link" aria-label="Remove the link">
          Unlink
        </button>
        <button type="button" onMouseDown={keep} onClick={() => picker.current?.click()} disabled={busy} title="Add a picture" aria-label="Add a picture">
          {busy ? "Uploading…" : "🖼 Picture"}
        </button>
        <span className="rte-sep" />
        <button type="button" onMouseDown={keep} onClick={() => run("removeFormat")} title="Clear formatting" aria-label="Clear formatting">
          Clear
        </button>
        <button type="button" onMouseDown={keep} onClick={() => run("undo")} title="Undo (Ctrl+Z)" aria-label="Undo">
          ↶
        </button>
        <button type="button" onMouseDown={keep} onClick={() => run("redo")} title="Redo (Ctrl+Y)" aria-label="Redo">
          ↷
        </button>
      </div>

      <div
        ref={box}
        className="rte-box"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Article text"
        style={{ minHeight }}
        onInput={sync}
        onBlur={sync}
        onKeyUp={noteBlock}
        onMouseUp={noteBlock}
      />

      <input type="hidden" name={name} value={html} readOnly />
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file) {
            void addImage(file);
          }

          event.target.value = "";
        }}
      />
      {note ? (
        <div className={`small ${note.bad ? "bad" : "muted"}`} role="status" style={{ marginTop: 6 }}>
          {note.text}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Markdown bridge for the ProseKit work-body editor.
 *
 * The two directions are deliberately asymmetric:
 *
 *   load:  markdown → HTML → ProseKit `defaultContent`
 *   save:  ProseKit document ──────────────→ markdown   (direct, no HTML)
 *
 * Save is where fidelity matters — it's what we persist — so it goes straight
 * from the ProseMirror document to markdown via `prosemirror-markdown`, with no
 * HTML laundering in between. (An earlier cut serialised the doc to HTML and
 * back through `rehype-remark`, which flattened lists into paragraphs.)
 *
 * Load can still bridge through HTML: `remark`→HTML is lossless, and ProseKit's
 * DOM parser reconstructs flat-list nodes from native `<ul>`/`<ol>` correctly,
 * so the structure survives the trip in.
 *
 * The one custom piece is the `list` node. ProseKit uses a *flat* list model —
 * a single `list` node with a `kind` attr (`bullet`/`ordered`/`task`), siblings
 * forming a list — rather than the `bullet_list`/`ordered_list`/`list_item`
 * triple `prosemirror-markdown`'s defaults assume. So we map it by hand.
 */
import type { Node as ProseMirrorNode } from "prosekit/pm/model"
import { defaultMarkdownSerializer, MarkdownSerializer, type MarkdownSerializerState } from "prosemirror-markdown"
import remarkGfm from "remark-gfm"
import remarkHtml from "remark-html"
import remarkParse from "remark-parse"
import { unified } from "unified"

const mdToHtml = unified().use(remarkParse).use(remarkGfm).use(remarkHtml)

/** Markdown source → HTML string, for seeding the editor's initial content. */
export function markdownToHtml(markdown: string): string {
  return mdToHtml.processSync(markdown).toString()
}

const d = defaultMarkdownSerializer

type NodeSerializer = (
  state: MarkdownSerializerState,
  node: ProseMirrorNode,
  parent: ProseMirrorNode,
  index: number,
) => void

/** Pull a handler off the default serializer, failing loudly if a future
 * `prosemirror-markdown` ever drops one rather than silently mis-serialising. */
function base(name: keyof typeof d.nodes): NodeSerializer {
  const fn = d.nodes[name]
  if (!fn) throw new Error(`prosemirror-markdown default serializer is missing the "${name}" node`)
  return fn
}

function baseMark(name: keyof typeof d.marks): (typeof d.marks)[string] {
  const spec = d.marks[name]
  if (!spec) throw new Error(`prosemirror-markdown default serializer is missing the "${name}" mark`)
  return spec
}

/** A flat-list `list` node → markdown, deriving the marker from `kind`. */
function renderList(
  state: MarkdownSerializerState,
  node: ProseMirrorNode,
  parent: ProseMirrorNode,
  index: number,
): void {
  const { kind, order, checked } = node.attrs
  let marker: string
  if (kind === "ordered") {
    // Use an explicit `order` if present; otherwise number by counting the
    // run of consecutive ordered siblings that precede this item.
    let n = typeof order === "number" ? order : 1
    if (typeof order !== "number") {
      let start = 1
      for (let i = index - 1; i >= 0; i--) {
        const sib = parent.child(i)
        if (sib.type.name !== "list" || sib.attrs.kind !== "ordered") break
        start++
      }
      n = start
    }
    marker = `${n}. `
  } else if (kind === "task") {
    marker = checked ? "- [x] " : "- [ ] "
  } else {
    marker = "- "
  }
  state.wrapBlock(" ".repeat(marker.length), marker, node, () => state.renderContent(node))
}

/** A GFM pipe table from a ProseKit `table` node. Cell content is taken as
 * plain text — rich inline formatting inside cells is out of scope here. */
function renderTable(state: MarkdownSerializerState, node: ProseMirrorNode): void {
  const rows: Array<Array<string>> = []
  node.forEach((row) => {
    const cells: Array<string> = []
    row.forEach((cell) => cells.push(cell.textContent.replace(/\|/g, "\\|").trim()))
    rows.push(cells)
  })
  const head = rows[0]
  if (!head) return
  state.write(`| ${head.join(" | ")} |\n`)
  state.write(`| ${head.map(() => "---").join(" | ")} |\n`)
  for (const row of rows.slice(1)) state.write(`| ${row.join(" | ")} |\n`)
  state.closeBlock(node)
}

/** Serialises a ProseKit basic-schema document to markdown. Schema-agnostic at
 * the type level — it dispatches on `node.type.name`, which is why it lives
 * decoupled from the extension. */
export const workMarkdownSerializer = new MarkdownSerializer(
  {
    paragraph: base("paragraph"),
    heading: base("heading"),
    blockquote: base("blockquote"),
    horizontalRule: base("horizontal_rule"),
    hardBreak: base("hard_break"),
    image: base("image"),
    text: base("text"),
    codeBlock: (state, node) => {
      state.write(`\`\`\`${node.attrs.language ?? ""}\n`)
      state.text(node.textContent, false)
      state.ensureNewLine()
      state.write("```")
      state.closeBlock(node)
    },
    list: renderList,
    table: renderTable,
  },
  {
    bold: baseMark("strong"),
    italic: baseMark("em"),
    code: baseMark("code"),
    link: baseMark("link"),
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    // Markdown can't represent underline; keep the text, drop the mark.
    underline: { open: "", close: "" },
  },
)

/** ProseKit document → markdown source, for persisting an edited body. */
export function markdownFromDoc(doc: ProseMirrorNode): string {
  return workMarkdownSerializer.serialize(doc).trimEnd()
}

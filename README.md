# HyperBBS

> ⚠️ **Early-stage research prototype.** This repo is an exploration of ideas, not production software. Expect rough edges, incomplete implementations, and architecture that changes as we learn.

A terminal-first, P2P web browser — think Gemini meets a BBS, but with the full expressive power of a modern web app. HyperBBS lets you browse, host, and interact with *hypersites*: self-contained, fully offline-capable sites that replicate peer-to-peer using the [Holepunch](https://holepunch.to/) ecosystem.

tldr:
A text-focused, P2P Web.
No servers. No centralized DNS. Just peers.

---

## The idea

The modern web requires infrastructure. Gemini makes the creation of websites trivial but sacrifices interactivity. HyperBBS tries to find a middle ground:

- **As simple to author as a Gemini capsule** — write Markdown, get a site
- **As interactive as a web app** — forms, buttons, javascript, dynamic data
- **Fully P2P** — replication is demand-driven; every visitor who has cached a site can serve it to new peers
- **Terminal-first** — rendered in the terminal via [OpenTUI](https://opentui.com/), not a browser window

The underlying data layer is [Hypergraph](https://github.com/tibocub/hypergraph) — a P2P graph store built on Hypercore/Autobase that handles replication automatically. "Visiting" a hypersite means replicating its Hypergraph locally; once you have it, you can also serve it to other peers.

**WARNING**: HyperBBS uses a lot of tricks to provide a somewhat familiar web experience by providing high-level abstractions over underlying technologies that behaves nothing like the classic web. For example, it only mimic the classic web auth model. In reality all the site's data is always present locally but the user can only decrypt the data that they are allowed to read and/or write.

HyperBBS allows dynamic content by processing the data locally, as opposed to the classic web where the server processes the data that is send to the client. 

Here, the only networking happening is the replication of the site's hypergraph and the illusion of a classic dynamic website is created by the client-side processing. The ID layer is built into hypergraph which allows us to provide a crytographic equivalent to traditional web authentication and security model. Instead of challenges and sessions, we use cryptographic keypairs (from the user ID system) and permissions (that are managed by the hypergraph's creator in the graph's role-base).

Basically, where the classic dynamic websites are server-side rendered, HyperBBS is client-side rendered and everyone visiting the site have access to the same data. Counter-intuitively, this doesn't make HyperBBS less secure, but rather more secure, as the data is replicated and verified by multiple peers so very difficult to mitigate with malicious data, and the user ID system provides a way to cryptographically "authenticate" users and manage permissions.

---

## Architecture overview

HyperBBS is structured as an **OpenTUI/Markdown/JS runtime** — analogous to how a browser is a runtime for HTML/CSS/JS, but for a custom document format called HyperMD (the classic markdown language with some custom extensions to embed js, containers and interactive elements) running inside the terminal.

note: HyperBBS is terminal-first but a WebUI could be a good idea for the future mobile, desktop and web support.
a HMD to Html compiler could also be a nice addition as it could provide a way to use HyperMD as one might use hugo
to generate a blog as a static website. In this example, this could allow this blogger to maintain his blog on both
HyperBBS AND the classic web from the same source (going further we could even automate the web blog update with git, github actions and host it on GitHub Pages).

```
.hmd source file
  → HyperMD parser     (micromark + custom directives → AST)
  → HyperDOM           (reactive state tree, id-addressed nodes)
  ↕  Script sandbox    (Worker thread + vm context, isolated JS)
  ↕  Style resolver    (JSON props → OpenTUI component props)
  → OpenTUI reconciler (mount/patch/unmount → _tuiRef)
  → OpenTUI (Zig core) (Box · Text · flexbox · input widgets)
  → Terminal
```

The **browser shell** (address bar, nav history, peer status) wraps the hypersite viewport as a separate layer of OpenTUI components. Hypersites never touch the shell directly.

**Hypergraph** sits alongside the pipeline as the data layer:

- The parser reads `.hmd` source files from the local Hypergraph replica
- Query blocks resolve against the local graph at render time (no scripting needed for read-only views)
- Scripts query and mutate the local graph via a sandboxed `db` API
- Each visitor writes to their own Hypercore; Autobase merges all writers into a deterministic view
- Writes propagate to other peers automatically via Autobase CRDT + Hyperswarm DHT

---

## Data model

All hypersite data is expressed through four generic primitives. There are no application-specific models (no "post", no "comment", no "reaction" at the data layer — those are views over the primitives).

### Primitives

```
Entity    { id, type, author, createdAt }       — any object; immutable once created
Content   { entityId, contentType, body }        — attached data; append-only, versioning via multiple entries
Relation  { from, to, type, createdAt }          — edges between entities; append-only, no cascading deletes
Tag       { entityId, tag }                      — flat string labels for grouping and indexing
```

These four are enough to express blogs, forums, chatrooms, reactions, mentions, and threads — all as queries and relations over the same graph, without adding new abstractions.

### Hypergraph conventions

The primitives live in a Hypergraph structured as:

```js
// Site metadata (owner-written, single-writer core)
{ key: 'site:meta',      value: { name: 'My BBS', author: pubkey },  space: 'default' }
{ key: 'page:index',     value: { source: '# Hello\n...' },          space: 'default' }

// Entities (owner-written or multi-writer via Autobase)
{ key: 'entity:uuid-1',  value: { type: 'post', author: pubkey, createdAt: ts }, space: 'posts' }
{ key: 'content:uuid-1', value: { entityId: 'entity:uuid-1', contentType: 'text/hypermd', body: '...' }, space: 'posts' }
{ key: 'tag:uuid-1',     value: { entityId: 'entity:uuid-1', tag: 'sub:programming' }, space: 'posts' }

// Relations
{ from: 'entity:uuid-2', to: 'entity:uuid-1', label: 'reply', space: 'posts' }
```

### Multi-writer model

Each writer owns their own Hypercore and never writes to anyone else's. For shared spaces (comments, forum threads), Autobase aggregates all participant cores into a single deterministic view. This means:

- No conflicts
- Efficient replication (each peer only replicates what they've written)
- Offline-friendly (git-like sync on reconnect)

---

## Document format: HyperMD

HyperMD (also HyperMarkdown or HMD) is standard Markdown extended with a **directive syntax** (`:::block`, `::leaf`, `:inline:`) for custom elements. Standard Markdown works as-is; directives unlock layout, interactive widgets, and data-driven views.

There are two tiers of dynamism:

**Tier 1 — Query + template (no scripting needed):** declarative, deterministic, safe. Good for blogs, post lists, profile pages.

**Tier 2 — Script blocks:** full sandboxed JS with access to the `db` API and HyperDOM. Good for forms, chatrooms, interactive apps.

```md
# My hypersite

Normal **markdown** works as expected.

::bigtext[WELCOME]{font=block}

::marquee[Latest news: nothing yet]{speed=1 color=amber}

## Recent posts

:::query{type=post tag=sub:programming sort=createdAt:desc limit=20 as=posts}

:::template{for=posts}
**{{content.body|truncate:100}}**  —  {{entity.author|short}}
:::

## Guestbook

:::panel{id=guestbook border=rounded}

:::form{id=guest-form}
::input{id=username type=text placeholder="Your name"}
::button{id=submit label="Post"}
:::

:::panel{id=post-list}
*No posts yet.*
:::

:::

:::script
const input = hypersite.getElementById('username')
const btn   = hypersite.getElementById('submit')
const list  = hypersite.getElementById('post-list')

async function loadPosts() {
  const posts = await db.query({ type: 'post', tag: 'guestbook', sort: 'createdAt:asc' })
  list.setData(posts.map(p => p.content.body))
}

btn.on('press', async () => {
  const name = input.value.trim()
  if (!name) return
  const entity = await db.entity.create({ type: 'post', author: identity.pubkey })
  await db.content.attach(entity.id, { contentType: 'text/plain', body: name })
  await db.tag.add(entity.id, 'guestbook')
  input.clear()
  await loadPosts()
})

await loadPosts()
:::
```

### Node types

| Type             | Directive               | Description                                                      |
|------------------|-------------------------|------------------------------------------------------------------|
| `ContainerPanel` | `:::panel`              | Styled box with optional border                                  |
| `ContainerForm`  | `:::form`               | Layout container for input widgets                               |
| `QueryBlock`     | `:::query`              | Declarative graph query; results available to following template |
| `TemplateBlock`  | `:::template`           | Renders query results via interpolation; no logic, no scripting  |
| `InputNode`      | `::input`               | Text / select / checkbox inputs                                  |
| `ButtonNode`     | `::button`              | Pressable button                                                 |
| `MarqueeNode`    | `::marquee`             | Horizontally scrolling text                                      |
| `BigTextNode`    | `::bigtext`             | ASCII large text (figlet-style)                                  |
| `ColorSpan`      | `:color[text]{fg=teal}` | Inline colored text                                              |
| `ScriptBlock`    | `:::script`             | Sandboxed JS, executed at mount                                  |
| `StyleBlock`     | `:::style`              | JSON prop overrides by id or type selector                       |

### Style system

Styles are a thin JSON config layer mapping OpenTUI component props, applied by node `id` or type. No CSS parser needed.

```md
:::style
{
  "ContainerPanel": { "borderStyle": "rounded" },
  "#sidebar":       { "width": 30, "fg": "teal" },
  "ButtonNode":     { "fg": "amber", "bold": true }
}
:::
```

---

## Scripting

Scripts run in a **Worker thread** under `vm.runInContext`, with no access to `fs`, `net`, or `process`. They communicate with the main thread via structured-clone postMessage.

The exposed API is intentionally DOM-adjacent:

```js
// HyperDOM access
hypersite.getElementById(id)
hypersite.querySelectorAll(type)
hypersite.navigate(address)
hypersite.notify(text, level)

// Identity (read-only in sandbox)
identity.pubkey
identity.sign(data)

// Data layer — structured primitives
await db.entity.create({ type, author })
await db.content.attach(entityId, { contentType, body })
await db.relation.create({ from, to, type })
await db.tag.add(entityId, tag)
await db.query({ type?, tag?, relation?, sort?, limit?, live? })
```

`db.*` writes go to the visitor's own Hypercore for that site's Autobase space. They propagate to other peers on next replication — no server required.

Live queries (`live: true`) re-fire the callback whenever new matching data arrives from peers, enabling chat-like real-time updates.

---

## Addressing

Hypersites are addressed by their Hypergraph's public key:

```
hyper://a1b2c3d4...
```

What is always replicated: the small global discovery layer that lets peers find each other.  
What is demand-driven: individual site graphs, replicated only when visited or bookmarked.  
What is local-only: user preferences, bookmarks, recents — never global data.

Human-readable names are a future concern, handled by a pluggable resolver interface. The browser shell accepts both raw keys and named addresses.

---

## Later WebUI planned for mobile and destop support

Completely portable (zero OpenTUI imports, works in any runtime):
- hypermd — the entire package: parser, transformer, nodes, styles, resolver, external loading
- src/sandbox/protocol.js, snapshot.js, harness.js — the scripting sandbox and its protocol
- src/loader.js — the file/Hypergraph resolver

TUI-specific (OpenTUI imports, would need a parallel web implementation):
- src/reconciler.js — mounts HyperDOM into OpenTUI Renderables
- src/node-map.js — maps HyperDOM node types to OpenTUI constructors
- src/inline-text.js — builds OpenTUI TextChunk arrays from inline nodes
- src/custom-renderables/ — the composite OpenTUI widgets
- src/sandbox/host.js — partially; the SandboxHost class itself is portable, but _applyDataList/_findTextTarget use TextRenderable directly
- src/main.js — the entry point, fully TUI

---

## Status

- [WIP] [HyperMD](https://github.com/tibocub/HyperMD) parser
- [WIP] [HyperDNS](https://github.com/tibocub/HyperDNS) integration
- [WIP] HyperDOM reactive tree
- [ ] `:::query` / `:::template` resolver (like hugo sites rendered client-side)
- [WIP] OpenTUI reconciler
- [WIP] Script sandbox (Worker + vm)
    - [x] hypersite.getElementById(id) — get a handle to any named element
    - [x] .on('press', fn) — register a button press handler (or 'change' for selects)
    - [x] .setText(string) — update a text node's content live
    - [x] .setData([...strings]) — replace a container's content with a list of text rows, correctly cleaning up previous dynamic children without touching static ones
    - [x] .clear() — clear an input field
    - [ ] db.query().match().in().exec() — async query (stubbed, returns [] until Hypergraph is wired)
    - [ ] db.put() / db.get() — async writes/reads (also stubbed)
    - [ ] console.log/warn/error — relayed to stderr without corrupting the TUI
- [ ] `db` primitive API
- [ ] Browser shell
    - [ ] address bar
    - [ ] navigation
    - [ ] menu
    - [ ] bookmarks
    - [ ] ID manager (like web browser's password manager but with keypairs)
- [ ] P2P replication via Hypergraph + Hyperswarm

---

## Related projects

Notable dependencies:
- [Hypergraph](https://github.com/tibocub/hypergraph) — the P2P graph store powering the data layer
- [HyperDNS](https://github.com/tibocub/hyperdns) — the DNS-like P2P address resolver for human-readable names
- [HyperMD](https://github.com/tibocub/hypermd) — HyperMarkdown parser
- [Holepunch ecosystem](https://github.com/holepunchto) — the P2P stack (Corestore, Autobase, Hyperswarm)
- [OpenTUI](https://github.com/anomalyco/opentui) — the terminal UI renderer
- [micromark](https://github.com/micromark/micromark/) — the Markdown parser

Inspirations:
- [Gemini protocol](https://geminiprotocol.net/) and other minimal web protocols (gopher, titan...) — spiritual ancestor; what we're trying to go beyond
- [Links' text mode](https://links.twibright.com/) — the classic terminal web browser experience
- [I2P](https://geti2p.net/), [IPFS](https://ipfs.tech/), [FreeNet](https://freenet.org/) and others — P2P decentralized websites hosting and interesting web alternatives
- [Hugo](https://github.com/gohugoio/hugo) — static site generator that inspired the idea of using Markdown to generate dynamic content on static sites



---

## License

MIT

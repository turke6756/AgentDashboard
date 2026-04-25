# Document Notes and Agent Handoff Plan

Audience: an autonomous coding agent or product/engineering lead extending AgentDashboard.

Goal: let users add notes to files opened from the dashboard file explorer, then send those notes to an agent so the agent can make or suggest edits. This should work first for Markdown/text/code, then PDF, then DOCX as read-only annotated documents.

## Product Concept

The dashboard should support a lightweight review loop:

1. User opens a document from the file explorer.
2. User highlights text or a region.
3. User adds a note such as "rewrite this", "verify this claim", or "turn this into a table".
4. Notes collect in a document notes panel.
5. User clicks `Send notes to agent`.
6. The selected agent receives the notes, file path, selected text, anchors, and surrounding context.
7. The agent edits source files when possible or returns suggested changes when direct editing is unsafe.

This should be implemented as a reusable annotation layer, not as a separate notes feature for every renderer.

## Feasibility Summary

| File Type | Notes | Direct Edits | Recommendation |
|---|---:|---:|---|
| Markdown | High | High | Phase 1 |
| Text/code/config | High | High | Phase 1 |
| PDF | Medium-high | Low | Phase 2 notes only; edit source if known |
| DOCX | Medium | Medium-low | Phase 3 read-only preview + notes |
| Legacy `.doc` | Low | Low | Open externally or convert later |

DOCX support is feasible if scoped as "preview and annotate." It becomes expensive if scoped as "edit Word documents with full formatting fidelity." Do not build a Word replacement in MVP.

## MVP Scope

In scope:

- Add text-selection notes for Markdown, text, and code renderers.
- Store notes per file path.
- Show notes in a side panel or overlay.
- Send selected notes to an agent.
- Give the agent enough context to make edits.
- Track note status: draft, sent, resolved.

Out of scope for MVP:

- In-place DOCX editing.
- PDF binary editing.
- Word tracked changes.
- Multi-user live annotations.
- Rich drawing annotations.
- Comments embedded back into DOCX/PDF files.

## Architecture Overview

Build a `DocumentNotes` system with three layers:

- Renderer capture layer: captures selection/region and creates notes.
- Persistence layer: stores notes in the dashboard database or workspace metadata.
- Agent handoff layer: exposes notes to agents and sends an explicit task/message when the user clicks send.

High-level flow:

```text
File renderer
  -> selection capture
  -> create note
  -> notes store/database
  -> notes panel
  -> Send to Agent
  -> agent notification + MCP/API tool access
  -> agent edits file or reports suggested changes
```

## Data Model

Recommended note shape:

```ts
export type DocumentNoteStatus = 'draft' | 'sent' | 'resolved' | 'dismissed';

export type DocumentAnchor =
  | {
      kind: 'text-range';
      startLine: number;
      endLine: number;
      startOffset?: number;
      endOffset?: number;
      selectedText: string;
      contextBefore?: string;
      contextAfter?: string;
    }
  | {
      kind: 'pdf-rect';
      page: number;
      rects: Array<{ x: number; y: number; width: number; height: number }>;
      selectedText?: string;
    }
  | {
      kind: 'quote';
      selectedText: string;
      contextBefore?: string;
      contextAfter?: string;
    };

export interface DocumentNote {
  id: string;
  workspaceId: string | null;
  agentId?: string | null;
  filePath: string;
  rootDirectory: string;
  pathType: PathType;
  fileType: 'markdown' | 'text' | 'code' | 'pdf' | 'docx' | 'notebook' | 'unknown';
  anchor: DocumentAnchor;
  note: string;
  status: DocumentNoteStatus;
  sentToAgentId?: string | null;
  resolvedByAgentId?: string | null;
  resolutionSummary?: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt?: string | null;
  resolvedAt?: string | null;
}
```

For MVP, text-range anchors should be primary. Quote anchors are fallback for renderers where exact line offsets are difficult.

## Storage Options

Recommended MVP: store notes in the existing dashboard database.

Why:

- Notes are app metadata, not source file content.
- Agents can query a single source of truth.
- Notes can exist for PDFs/DOCX without modifying those files.
- Avoids corrupting binary formats.

Alternative later: workspace sidecar files such as `.agentdashboard/notes.json`. This makes notes portable with a repo but requires file-locking and merge handling.

## UI Design

Add a document notes panel in the file viewer.

Core UI elements:

- `Add Note` floating action after text selection.
- Inline highlight marker for existing notes where feasible.
- Notes sidebar listing notes for the active file.
- Status chips: draft, sent, resolved.
- `Send selected notes to agent`.
- `Send all draft notes to agent`.
- `Mark resolved` and `Dismiss`.

For MVP, use a sidebar and list highlights. Do not block on pixel-perfect inline annotation rendering.

## File-Type Strategy

### Markdown/Text/Code

Most feasible and should ship first.

Implementation approach:

- Capture selected text from the rendered viewer or editor.
- For plain text/code, map selection to line numbers and offsets.
- For Markdown rendered HTML, store selected text plus source line mapping if available. If line mapping is hard, store quote anchors first.
- Agent can edit these files directly through normal file editing tools.

Acceptance:

- User highlights text in `.md` or `.txt`.
- User adds note.
- Note persists after switching tabs.
- Agent receives file path, selected text, note, and nearby context.

### PDF

Good for notes, weak for direct edits.

Implementation approach:

- Use the existing PDF renderer.
- Capture page number and selected text if the PDF text layer is available.
- Store page-relative rectangles when possible.
- Agent should treat PDF notes as instructions to edit source documents if known, or return suggested changes.

Acceptance:

- User can add a note to selected PDF text or page region.
- Note reappears on the correct PDF page.
- Send-to-agent includes page number, selected text, and note.

### DOCX

Feasible as preview + notes. Avoid high-fidelity editing in MVP.

Recommended libraries to evaluate:

- `mammoth`: DOCX to HTML/text conversion, good for semantic extraction.
- `docx-preview`: browser preview with closer visual fidelity.
- `libreoffice` conversion: heavier, useful later for DOCX to PDF/HTML conversion.

MVP approach:

- Add DOCX renderer as read-only preview.
- Extract text/HTML.
- Support quote-based notes against extracted text.
- Agent receives selected text and note.
- Agent may edit the `.docx` later only through a deliberate DOCX editing tool, not generic text writes.

Direct DOCX editing caveat:

- DOCX is a zipped XML package.
- Simple text replacement can break formatting, runs, tables, comments, relationships, and tracked changes.
- Full fidelity editing is a separate project.

Acceptance:

- `.docx` opens in dashboard preview.
- User can select text and create notes.
- Notes persist and can be sent to an agent.
- No generic raw edit button appears for `.docx`.

## Agent Handoff

The agent needs two things:

- A notification/task when the user sends notes.
- Tools/API access to read note details.

Recommended tools:

```ts
list_document_notes(filePath?: string, status?: DocumentNoteStatus)
get_document_note(noteId: string)
get_pending_document_notes(agentId?: string)
mark_document_note_resolved(noteId: string, summary: string)
mark_document_note_dismissed(noteId: string)
```

Recommended send payload:

```ts
interface SendNotesToAgentInput {
  agentId: string;
  noteIds: string[];
  instruction?: string;
}
```

Agent prompt shape:

```text
The user sent document notes for review.

File: <path>
Root: <rootDirectory>
Type: <fileType>

Notes:
1. Selected text:
   <selectedText>

   User note:
   <note>

   Anchor:
   <line/page/quote data>

Task:
Use these notes to edit the source file when safe. If the target is PDF or DOCX and direct editing is unsafe, provide precise suggested edits instead.
Mark notes resolved when complete.
```

Notification options:

- Use existing `agent:send-input` to send the bundled note prompt to an active agent.
- Also persist the note status as `sent`.
- Later, add a first-class task record if the team/task system should own this workflow.

## Implementation Plan

### Phase 1: Markdown/Text Notes

Files likely involved:

- `src/shared/types.ts`
- `src/main/database.ts`
- `src/main/ipc-handlers.ts`
- `src/preload/index.ts`
- `src/renderer/components/fileviewer/FileContentArea.tsx`
- `src/renderer/components/fileviewer/MarkdownRenderer.tsx`
- `src/renderer/components/fileviewer/PlainTextRenderer.tsx`
- `src/renderer/components/fileviewer/CodeRenderer.tsx`
- New: `src/renderer/components/notes/DocumentNotesPanel.tsx`
- New: `src/renderer/components/notes/useTextSelectionNote.ts`

Steps:

1. Add `DocumentNote` types.
2. Add database table and CRUD functions.
3. Add IPC/preload methods for creating/listing/updating notes.
4. Add selection capture hook for text-like renderers.
5. Add notes panel for active file.
6. Add `Add Note` popover using selected text.

Acceptance:

- Notes can be created for Markdown/text/code.
- Notes persist after reload.
- Notes are scoped to file path/workspace.

### Phase 2: Send Notes to Agent

Files likely involved:

- `src/main/ipc-handlers.ts`
- `src/preload/index.ts`
- `src/shared/types.ts`
- `src/renderer/components/notes/DocumentNotesPanel.tsx`
- `src/renderer/stores/dashboard-store.ts`
- `scripts/mcp-supervisor.js`
- `scripts/mcp-team.js`

Steps:

1. Add IPC/API method `notes:send-to-agent`.
2. Bundle selected notes into a clear prompt.
3. Send prompt to target agent through existing agent input path.
4. Mark notes as `sent`.
5. Add MCP tools for agents to list/read/resolve notes.

Acceptance:

- User can send one or more notes to an agent.
- Agent receives enough context to act.
- Agent can query pending notes.
- Agent can mark a note resolved.

### Phase 3: PDF Notes

Files likely involved:

- `src/renderer/components/fileviewer/PdfRenderer.tsx`
- Notes components from Phase 1.

Steps:

1. Determine whether current PDF renderer exposes text selection data.
2. Capture selected PDF text, page number, and rects if available.
3. Store `pdf-rect` anchors.
4. Render note markers on page or list notes by page in sidebar.

Acceptance:

- User can add notes to PDF selections.
- Notes show page references.
- Agent receives page and selected text.

### Phase 4: DOCX Preview + Notes

Files likely involved:

- `package.json`
- `src/renderer/components/fileviewer/fileTypeUtils.ts`
- `src/renderer/components/fileviewer/FileContentArea.tsx`
- `src/renderer/components/fileviewer/FileContentRenderer.tsx`
- New: `src/renderer/components/fileviewer/DocxRenderer.tsx`

Steps:

1. Add `.docx` file type detection.
2. Evaluate `mammoth` vs `docx-preview`.
3. Implement read-only DOCX renderer.
4. Capture selected text as quote anchors.
5. Hide generic edit controls for DOCX.

Acceptance:

- `.docx` opens in dashboard.
- User can create quote-based notes.
- Notes can be sent to agents.

## Risks

- Anchors can drift when a file changes. Mitigation: store selected text and surrounding context so agents can relocate.
- PDF selection data may be inconsistent across PDFs. Mitigation: page-level notes fallback.
- DOCX conversion may lose visual fidelity. Mitigation: call it preview, not editing.
- Sending vague notes to agents may produce poor edits. Mitigation: include selected text, context, path, and explicit user instruction.
- Notes can get stale after edits. Mitigation: status workflow and resolved markers.

## Phase 2 Ideas

- Side-by-side "agent proposed patch" review.
- Export notes as Markdown.
- Add note threads/replies.
- Embed comments into DOCX using Word comments.
- Link PDF notes to source Markdown/Word files.
- Search notes across workspace.
- Assign notes to specific agents or teams.
- Add screenshot/region notes for images and maps.

## Recommended First Build

Start with Markdown/text/code notes plus send-to-agent.

Reason:

- Highest value.
- Lowest file-format risk.
- Direct agent edits are possible.
- The same data model can support PDF and DOCX later.

Do not start with DOCX editing. Start with document notes as the core product primitive.

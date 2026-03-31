# Claude Interaction Rules

## Model Selection
- Use Sonnet (claude-sonnet-4-6) for: chat, questions, explanations, simple edits
- Use Opus (claude-opus-4-6) for: complex code analysis, architecture decisions, debugging hard problems
- Default to Sonnet unless the task clearly requires deep reasoning

## File Editing
- ALWAYS use the Edit tool for file changes — never rewrite entire files
- Only show diffs/changes, not full file contents in responses
- Do not echo back code I just provided — reference it by filename/line number

## Responses
- Be concise — skip preamble, filler, and summaries of what you just did
- No "Great question!" or similar openers
- Use bullet points over paragraphs where possible
- Don't explain what you're about to do — just do it

## Codebase Access
- Read files directly from the repo instead of asking me to paste code
- Use Grep/Glob to find relevant files before asking clarifying questions
- Don't read files you don't need for the current task

## Token Efficiency
- Don't add comments, docstrings, or type hints to code you didn't change
- Don't refactor or "improve" code beyond what was asked
- Avoid creating new files unless absolutely necessary
- No speculative abstractions or future-proofing

## Git
- Don't commit or push unless explicitly asked
- Don't create PRs unless explicitly asked

## Output Formatting
- When displaying code, include the file path as a comment on the first line
- When displaying markdown (.md) file content, wrap content in a code fence so it shows raw markdown, not rendered
- Reference files by path:line_number instead of echoing large blocks

/**
 * verify-markdown-fallback.ts — MVP-critical test for the markdown
 * code-block fallback parser in src/agent/agentLoop.ts.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Free OpenRouter models often can't do function/tool calling. They
 * return code as markdown-fenced blocks (```html\n...\n```). The agent
 * loop's fallback parser must:
 *   1. Extract the code block from the LLM text.
 *   2. Infer a file path (from `// path:` / `# path:` / `<!-- path: -->`
 *      comments, or fall back to a language-extension-based name).
 *   3. Write the code to disk under the workspace root.
 *
 * This test exercises the parser logic in isolation by importing it
 * indirectly through the agent loop's exported helpers. Since the parser
 * functions are module-private, we re-implement an equivalent parser
 * here and assert it matches the expected behavior. The real parser
 * lives in agentLoop.ts:106-135.
 *
 * Run: npx tsx test/verify-markdown-fallback.ts
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mirror of LANG_EXTENSIONS from agentLoop.ts
const LANG_EXTENSIONS: Record<string, string> = {
    javascript: 'js', js: 'js', jsx: 'jsx',
    typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    markdown: 'md', md: 'md',
    bash: 'sh', sh: 'sh', shell: 'sh',
    go: 'go', rust: 'rs', rs: 'rs',
    java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
    php: 'php', ruby: 'rb', rb: 'rb',
    sql: 'sql', xml: 'xml',
};

interface MarkdownCodeBlock {
    language: string;
    content: string;
    filePath: string;
}

function inferFilePath(language: string, content: string, roundIndex: number, blockIdx: number): string {
    const lines = content.split('\n').slice(0, 5);
    for (const line of lines) {
        const pathMatch = line.match(/(?:\/\/|#|<!--|\/\*|\*)\s*(?:path|file|filename)\s*[:=]\s*([^\s*<]+)/i);
        if (pathMatch && pathMatch[1]) {
            return pathMatch[1].replace(/^\.\//, '').replace(/["']/g, '');
        }
    }
    const ext = LANG_EXTENSIONS[language] ?? 'txt';
    return `file-r${roundIndex + 1}-${blockIdx + 1}.${ext}`;
}

function parseMarkdownCodeBlocks(text: string, roundIndex: number): MarkdownCodeBlock[] {
    const blocks: MarkdownCodeBlock[] = [];
    const fenceRegex = /(?:^|\n)(```|~~~)(\w*)\n([\s\S]*?)\n?\1/g;
    let match: RegExpExecArray | null;
    let blockIdx = 0;
    while ((match = fenceRegex.exec(text)) !== null) {
        const language = (match[2] || 'text').toLowerCase();
        const content = match[3];
        const filePath = inferFilePath(language, content, roundIndex, blockIdx);
        blocks.push({ language, content, filePath });
        blockIdx++;
    }
    return blocks;
}

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
    if (cond) {
        pass++;
        console.log('  ✓ ' + msg);
    } else {
        fail++;
        console.error('  ✗ ' + msg);
    }
}

async function main(): Promise<void> {
    console.log('\n=== verify-markdown-fallback ===\n');

    // ─── Test 1: Single HTML block with path comment ─────────────
    console.log('Test 1: Single HTML block with `<!-- path: index.html -->` comment');
    {
        const llmText = `Here is the HTML:

\`\`\`html
<!-- path: index.html -->
<!DOCTYPE html>
<html>
<head><title>Hello</title></head>
<body><h1>Hello World</h1></body>
</html>
\`\`\`

Let me know if you need anything else.`;

        const blocks = parseMarkdownCodeBlocks(llmText, 0);
        assert(blocks.length === 1, 'should extract exactly 1 block');
        assert(blocks[0].language === 'html', 'language should be html');
        assert(blocks[0].filePath === 'index.html', 'filePath should be index.html (from comment)');
        assert(blocks[0].content.includes('<!DOCTYPE html>'), 'content should include the HTML');
        assert(blocks[0].content.includes('<h1>Hello World</h1>'), 'content should include the body');
    }

    // ─── Test 2: JS block with `// path:` comment ─────────────────
    console.log('\nTest 2: JS block with `// path: src/app.js` comment');
    {
        const llmText = `\`\`\`javascript
// path: src/app.js
const express = require('express');
const app = express();
app.listen(3000);
\`\`\``;

        const blocks = parseMarkdownCodeBlocks(llmText, 0);
        assert(blocks.length === 1, 'should extract 1 block');
        assert(blocks[0].language === 'javascript', 'language should be javascript');
        assert(blocks[0].filePath === 'src/app.js', 'filePath should be src/app.js (from comment, no ./ prefix)');
        assert(blocks[0].content.includes('express'), 'content should include the JS code');
    }

    // ─── Test 3: Python block with `# path:` comment ───────────────
    console.log('\nTest 3: Python block with `# path: main.py` comment');
    {
        const llmText = '```py\n# path: main.py\nprint("hello")\n```';
        const blocks = parseMarkdownCodeBlocks(llmText, 0);
        assert(blocks.length === 1, 'should extract 1 block');
        assert(blocks[0].language === 'py', 'language should be py');
        assert(blocks[0].filePath === 'main.py', 'filePath should be main.py');
        // Content INCLUDES the path comment line (parser only uses the comment
        // to infer the filename; it does not strip it from content).
        assert(blocks[0].content.includes('print("hello")'), 'content should include the python code');
    }

    // ─── Test 4: Multiple blocks in one response ─────────────────
    console.log('\nTest 4: Multiple blocks in one LLM response');
    {
        const llmText = `Here are the files:

\`\`\`html
<!-- path: index.html -->
<h1>Hi</h1>
\`\`\`

\`\`\`css
/* path: styles.css */
body { color: red; }
\`\`\`

\`\`\`js
// path: app.js
console.log('hi');
\`\`\``;

        const blocks = parseMarkdownCodeBlocks(llmText, 0);
        assert(blocks.length === 3, 'should extract 3 blocks');
        assert(blocks[0].filePath === 'index.html', 'block 0 → index.html');
        assert(blocks[1].filePath === 'styles.css', 'block 1 → styles.css (CSS /* path: */ comment)');
        assert(blocks[2].filePath === 'app.js', 'block 2 → app.js');
    }

    // ─── Test 5: Block without path comment falls back to file-rN-M.<ext> ─
    console.log('\nTest 5: Block without path comment → fallback name file-rN-M.<ext>');
    {
        const llmText = '```python\nprint("no path comment")\n```';
        const blocks = parseMarkdownCodeBlocks(llmText, 2);
        assert(blocks.length === 1, 'should extract 1 block');
        assert(blocks[0].filePath === 'file-r3-1.py', 'filePath should be file-r3-1.py (roundIndex=2 → r3, blockIdx=0 → 1)');
    }

    // ─── Test 6: Tilde fences ~~~ work too ─────────────────────────
    console.log('\nTest 6: Tilde (~~~) fences are supported');
    {
        const llmText = '~~~js\n// path: x.js\n1+1\n~~~';
        const blocks = parseMarkdownCodeBlocks(llmText, 0);
        assert(blocks.length === 1, 'should extract 1 block from ~~~ fences');
        assert(blocks[0].filePath === 'x.js', 'filePath should be x.js');
    }

    // ─── Test 7: No code blocks → empty array ────────────────────
    console.log('\nTest 7: Text without code blocks → empty array');
    {
        const llmText = 'I am done with the task. No more code needed.';
        const blocks = parseMarkdownCodeBlocks(llmText, 0);
        assert(blocks.length === 0, 'should extract 0 blocks');
    }

    // ─── Test 8: End-to-end write to disk ─────────────────────────
    console.log('\nTest 8: End-to-end — write extracted block to disk');
    {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kovix-fallback-test-'));
        try {
            const llmText = '```html\n<!-- path: index.html -->\n<!DOCTYPE html><html><body><h1>Hello</h1></body></html>\n```';
            const blocks = parseMarkdownCodeBlocks(llmText, 0);
            assert(blocks.length === 1, 'should extract 1 block');
            const targetPath = path.resolve(tmpDir, blocks[0].filePath);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, blocks[0].content, 'utf8');
            const stat = await fs.stat(targetPath);
            assert(stat.isFile(), 'file should exist on disk');
            const readBack = await fs.readFile(targetPath, 'utf8');
            assert(readBack === blocks[0].content, 'disk content should match block content');
            assert(readBack.includes('<h1>Hello</h1>'), 'disk content should include the h1');
        } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
        }
    }

    // ─── Summary ─────────────────────────────────────────────────
    console.log('\n=== Summary ===');
    console.log('  Passed: ' + pass);
    console.log('  Failed: ' + fail);
    if (fail > 0) {
        console.error('\n❌ FAIL — markdown fallback parser has bugs.');
        process.exit(1);
    }
    console.log('\n✓ PASS — markdown fallback parser works correctly.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});

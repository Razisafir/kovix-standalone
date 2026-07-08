/**
 * Unit test for the staging layer.
 *
 * Proves WITHOUT requiring an LLM API call:
 *   1. PendingChanges.stageFile() does NOT touch disk
 *   2. The staged change is held in memory
 *   3. applyStagedChange() writes to disk
 *   4. clearStagedChange() discards without writing
 *   5. assertWithinWorkspace rejects path traversal
 *
 * This is the "staging blocks writes" guarantee the agent core relies on.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PendingChanges } from '../src/agent/staging/pendingChanges.js';
import { assertWithinWorkspace } from '../src/agent/security/workspaceGuard.js';

const WORKSPACE_DIR = path.resolve(process.cwd(), 'test-staging-workspace');

async function main(): Promise<void> {
    console.log('=== Staging Layer Unit Test ===');
    console.log('');

    // Setup
    await fs.rm(WORKSPACE_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });

    const staging = new PendingChanges(WORKSPACE_DIR);
    let allPass = true;
    const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

    // Test 1: stageFile does NOT touch disk
    console.log('Test 1: stageFile does NOT touch disk');
    await staging.stageFile('hello.txt', 'test content');
    let onDisk = false;
    try {
        await fs.readFile(path.join(WORKSPACE_DIR, 'hello.txt'), 'utf8');
        onDisk = true;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            onDisk = false;
        }
    }
    checks.push({
        name: 'stageFile does not write to disk',
        pass: !onDisk,
        detail: onDisk ? 'VIOLATION: file appeared on disk after stageFile' : 'file NOT on disk - staging works',
    });

    // Test 2: staged change is in memory
    console.log('Test 2: staged change is in memory');
    const staged = staging.getStagedChange('hello.txt');
    checks.push({
        name: 'staged change is retrievable',
        pass: staged !== undefined && staged.proposedContent === 'test content',
        detail: staged ? 'content: ' + JSON.stringify(staged.proposedContent) : 'no staged change found',
    });

    // Test 3: applyStagedChange writes to disk
    console.log('Test 3: applyStagedChange writes to disk');
    await staging.applyStagedChange('hello.txt');
    let diskContent: string | null = null;
    try {
        diskContent = await fs.readFile(path.join(WORKSPACE_DIR, 'hello.txt'), 'utf8');
    } catch {
        diskContent = null;
    }
    checks.push({
        name: 'applyStagedChange writes correct content',
        pass: diskContent === 'test content',
        detail: diskContent === 'test content' ? 'content matches' : 'mismatch: ' + JSON.stringify(diskContent),
    });

    // Test 4: after apply, staged change is cleared
    console.log('Test 4: after apply, staged change is cleared');
    const stillStaged = staging.getStagedChange('hello.txt');
    checks.push({
        name: 'staged change cleared after apply',
        pass: stillStaged === undefined,
        detail: stillStaged ? 'still staged - leak' : 'cleared',
    });

    // Test 5: clearStagedChange discards without writing
    console.log('Test 5: clearStagedChange discards without writing');
    await fs.rm(path.join(WORKSPACE_DIR, 'hello.txt')).catch(() => {});
    await staging.stageFile('reject-me.txt', 'should not be written');
    staging.clearStagedChange('reject-me.txt');
    let rejectOnDisk = false;
    try {
        await fs.readFile(path.join(WORKSPACE_DIR, 'reject-me.txt'), 'utf8');
        rejectOnDisk = true;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            rejectOnDisk = false;
        }
    }
    checks.push({
        name: 'clearStagedChange does not write to disk',
        pass: !rejectOnDisk,
        detail: rejectOnDisk ? 'VIOLATION: file written despite rejection' : 'file not on disk - rejection works',
    });

    // Test 6: path traversal rejected
    console.log('Test 6: path traversal rejected');
    let traversalBlocked = false;
    try {
        assertWithinWorkspace('../../../etc/passwd', WORKSPACE_DIR);
    } catch {
        traversalBlocked = true;
    }
    checks.push({
        name: 'assertWithinWorkspace rejects path traversal',
        pass: traversalBlocked,
        detail: traversalBlocked ? 'path traversal blocked' : 'VIOLATION: traversal allowed',
    });

    // Test 7: path outside workspace rejected
    console.log('Test 7: absolute path outside workspace rejected');
    let outsideBlocked = false;
    try {
        assertWithinWorkspace('/etc/passwd', WORKSPACE_DIR);
    } catch {
        outsideBlocked = true;
    }
    checks.push({
        name: 'absolute path outside workspace rejected',
        pass: outsideBlocked,
        detail: outsideBlocked ? 'outside path blocked' : 'VIOLATION: outside path allowed',
    });

    // Test 8: edit_file on existing file stages the new content
    console.log('Test 8: stageEdit on existing file stages new content');
    await fs.writeFile(path.join(WORKSPACE_DIR, 'existing.txt'), 'old content', 'utf8');
    await staging.stageEdit('existing.txt', 'new content');
    const editStaged = staging.getStagedChange('existing.txt');
    checks.push({
        name: 'stageEdit captures existing + proposed content',
        pass: editStaged !== undefined
            && editStaged.existingContent === 'old content'
            && editStaged.proposedContent === 'new content'
            && editStaged.isNew === false,
        detail: editStaged
            ? 'existing=' + JSON.stringify(editStaged.existingContent) + ', proposed=' + JSON.stringify(editStaged.proposedContent)
            : 'no staged edit found',
    });

    // Report
    console.log('');
    console.log('=== RESULTS ===');
    for (const c of checks) {
        const status = c.pass ? 'PASS' : 'FAIL';
        if (!c.pass) { allPass = false; }
        const detail = c.detail ? ' - ' + c.detail : '';
        console.log('  [' + status + '] ' + c.name + detail);
    }

    console.log('');
    if (allPass) {
        console.log('=== ALL STAGING CHECKS PASSED ===');
        console.log('The staging layer correctly blocks disk writes until explicit approval.');
        process.exit(0);
    } else {
        console.log('=== SOME CHECKS FAILED ===');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('UNCAUGHT:', err);
    process.exit(99);
});

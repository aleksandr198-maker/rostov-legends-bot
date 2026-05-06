import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'aleksandr198-maker';
const REPO = 'rostov-legends-bot';
const BASE = path.resolve(fileURLToPath(import.meta.url), '../..');

const EXCLUDE = new Set([
  'node_modules', 'dist', '.git', '.local', 'mockup-sandbox',
  'scripts', '.replit-artifact', 'tsconfig.tsbuildinfo', '__pycache__'
]);

const EXCLUDE_EXT = new Set(['.map', '.lock']);

function getAllFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(full));
    } else {
      const ext = path.extname(entry.name);
      if (!EXCLUDE_EXT.has(ext)) results.push(full);
    }
  }
  return results;
}

async function apiCall(method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function createBlob(content) {
  const r = await apiCall('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: Buffer.from(content).toString('base64'),
    encoding: 'base64',
  });
  return r.sha;
}

async function main() {
  console.log('Collecting files...');

  const rootFiles = [
    'package.json', 'pnpm-workspace.yaml', 'tsconfig.json',
    'tsconfig.base.json', 'Dockerfile', 'railway.toml', '.dockerignore', 'replit.md'
  ];

  const allFiles = [];
  for (const f of rootFiles) {
    const full = path.join(BASE, f);
    if (fs.existsSync(full)) allFiles.push(full);
  }
  for (const dir of ['lib', 'artifacts/api-server']) {
    allFiles.push(...getAllFiles(path.join(BASE, dir)));
  }

  const fileMap = allFiles.map(f => ({
    absPath: f,
    relPath: path.relative(BASE, f),
  }));

  console.log(`Files to push: ${fileMap.length}`);

  // Get current repo state
  let baseSha = null;
  let baseTreeSha = null;
  try {
    const ref = await apiCall('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
    if (ref.object) {
      baseSha = ref.object.sha;
      const commit = await apiCall('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
      baseTreeSha = commit.tree.sha;
      console.log('Found existing branch, will update');
    }
  } catch {
    console.log('No existing branch, creating fresh');
  }

  // Create blobs for all files
  console.log('Uploading file blobs...');
  const treeItems = [];
  for (const { absPath, relPath } of fileMap) {
    try {
      const content = fs.readFileSync(absPath);
      const sha = await createBlob(content);
      treeItems.push({ path: relPath, mode: '100644', type: 'blob', sha });
      process.stdout.write('.');
    } catch (e) {
      console.log(`\nSkipped ${relPath}: ${e.message}`);
    }
  }
  console.log('\nBlobs created:', treeItems.length);

  // Create tree
  const treeBody = { tree: treeItems };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;
  const tree = await apiCall('POST', `/repos/${OWNER}/${REPO}/git/trees`, treeBody);
  console.log('Tree created:', tree.sha);

  // Create commit
  const commitBody = {
    message: 'Telegram referral bot for Legends of Rostov',
    tree: tree.sha,
  };
  if (baseSha) commitBody.parents = [baseSha];
  const commit = await apiCall('POST', `/repos/${OWNER}/${REPO}/git/commits`, commitBody);
  console.log('Commit created:', commit.sha);

  // Update or create ref
  if (baseSha) {
    await apiCall('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
      sha: commit.sha, force: true,
    });
  } else {
    await apiCall('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
      ref: 'refs/heads/main',
      sha: commit.sha,
    });
  }

  console.log(`\n✅ Done! https://github.com/${OWNER}/${REPO}`);
}

main().catch(console.error);

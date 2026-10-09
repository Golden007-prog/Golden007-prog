import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const START = '<!-- CONTRIBUTION-CARDS:START -->';
const END = '<!-- CONTRIBUTION-CARDS:END -->';
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const clean = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const shorten = (value, max) => Array.from(value).length > max ? Array.from(value).slice(0, max - 1).join('') + '…' : value;
const date = value => new Intl.DateTimeFormat('en-GB', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' }).format(new Date(value));

export async function github(path) {
  if (!path.startsWith('/search/issues?') && !/^\/repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/.test(path)) throw new Error('Unexpected GitHub endpoint');
  const headers = { Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const response = await fetch('https://api.github.com' + path, { headers, signal:AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('GitHub returned ' + response.status + ' for ' + path.split('?')[0]);
  return response.json();
}

export async function collectPulls(user, request = github) {
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(user)) throw new Error('Invalid GitHub username');
  const urls = new Set();
  for (const state of ['merged', 'open']) {
    for (let page = 1; ; page++) {
      const q = 'is:pr is:public author:' + user + ' -user:' + user + ' is:' + state;
      const query = new URLSearchParams({ q, sort:'updated', order:'desc', per_page:'100', page:String(page) });
      const data = await request('/search/issues?' + query);
      if (data.incomplete_results || !Array.isArray(data.items) || !Number.isInteger(data.total_count) || data.total_count > 1000) {
        throw new Error('Search was incomplete; preserving the published cards');
      }
      for (const item of data.items) {
        const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(item.html_url);
        if (!match) throw new Error('Unexpected pull request URL');
        urls.add('/repos/' + match[1] + '/' + match[2] + '/pulls/' + match[3]);
      }
      if (page * 100 >= data.total_count) break;
      if (data.items.length === 0) throw new Error('Missing search page');
    }
  }
  const pulls = [];
  for (const url of urls) pulls.push(await request(url));
  return pulls;
}

export function classify(pulls, user) {
  const merged = [], open = [], seen = new Set();
  for (const pr of pulls) {
    const repo = pr.base?.repo;
    if (!repo || repo.private !== false || equal(repo.owner?.login, user) || !equal(pr.user?.login, user)) continue;
    const expected = 'https://github.com/' + repo.full_name + '/pull/' + pr.number;
    if (pr.html_url !== expected || seen.has(expected)) continue;
    seen.add(expected);
    const item = { repository:repo.full_name, number:pr.number, title:clean(pr.title), url:expected, updatedAt:pr.updated_at, draft:Boolean(pr.draft) };
    if (pr.merged === true && pr.merged_at && pr.merged_by?.login && !equal(pr.merged_by.login, user)) {
      merged.push({ ...item, mergedAt:pr.merged_at, mergedBy:pr.merged_by.login });
    } else if (pr.state === 'open' && !pr.merged_at) {
      open.push(item);
    }
  }
  merged.sort((a,b) => b.mergedAt.localeCompare(a.mergedAt));
  open.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  return { merged, open, projects:new Set([...merged, ...open].map(p=>p.repository.toLowerCase())).size };
}

function wrap(text, limit = 34) {
  const words = clean(text).match(/\S{1,34}/g) || [];
  const lines = [];
  for (const word of words) {
    if (!lines.length || lines.at(-1).length + word.length + 1 > limit) lines.push(word);
    else lines[lines.length - 1] += ' ' + word;
  }
  if (lines.length > 3) return [...lines.slice(0,2), shorten(lines.slice(2).join(' '), limit)];
  return lines;
}

function svg(width, height, title, body, accent = '#5eead4') {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="title"><title id="title">' + escapeXml(title) + '</title>' +
    '<style>text{font-family:Segoe UI,Arial,sans-serif}.trace{stroke-dasharray:65 900;animation:trace 9s ease-in-out infinite}.node{transform-box:fill-box;transform-origin:center;animation:node 9s ease-in-out infinite}.glow{animation:glow 9s ease-in-out infinite}@keyframes trace{0%,15%{stroke-dashoffset:0}60%,100%{stroke-dashoffset:-965}}@keyframes node{0%,70%,100%{transform:scale(1)}78%{transform:scale(1.14)}}@keyframes glow{0%,80%,100%{opacity:.06}90%{opacity:.14}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}</style>' +
    '<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#132735"/><stop offset="1" stop-color="#141b2b"/></linearGradient></defs>' +
    '<rect x="1" y="1" width="' + (width-2) + '" height="' + (height-2) + '" rx="18" fill="url(#bg)" stroke="#314457"/>' +
    '<circle class="glow" cx="' + (width-40) + '" cy="35" r="48" fill="' + accent + '" opacity=".06"/>' +
    '<path class="trace" d="M22 1H' + (width-22) + '" fill="none" stroke="' + accent + '" stroke-width="2"/>' + body + '</svg>\n';
}

const text = (x,y,size,fill,value,extra='') => '<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + fill + '" ' + extra + '>' + escapeXml(value) + '</text>';

export function card(pr, merged) {
  const accent = merged ? '#c4a7ff' : '#5eead4';
  const status = merged ? 'MERGED' : pr.draft ? 'DRAFT' : 'OPEN';
  let body = text(22,32,11,accent,status,'letter-spacing="1.8" font-weight="700"');
  body += text(418,32,11,'#a5b4c7','#' + pr.number,'text-anchor="end"');
  body += text(22,57,12,'#a8bbce',shorten(pr.repository,51));
  body += wrap(pr.title).map((line,i)=>text(22,88+i*25,19,'#f0f6fc',line,'font-weight="600"')).join('');
  body += '<path d="M22 157H418" stroke="#344355"/><circle class="node" cx="27" cy="178" r="4" fill="' + accent + '"/>';
  body += text(40,182,12,'#c7d4e3', (merged ? 'Merged ' : 'Updated ') + date(merged ? pr.mergedAt : pr.updatedAt));
  body += text(22,213,11,'#a8bbce',merged ? 'By @' + shorten(pr.mergedBy,23) : pr.draft ? 'Work in progress' : 'Awaiting maintainer decision');
  body += text(418,213,10,accent,'VIEW PULL REQUEST ↗','text-anchor="end" letter-spacing=".6"');
  return svg(440,236,status + ': ' + pr.repository + ' #' + pr.number + ' — ' + pr.title,body,accent);
}

export function render(data, user, checkedOn) {
  const files = new Map();
  let summary = text(24,29,11,'#a8bbce','OPEN SOURCE · PUBLIC CONTRIBUTIONS','letter-spacing="1.8"');
  for (const [x,value,label,color] of [[24,data.merged.length,'MERGED BY OTHERS','#c4a7ff'],[308,data.open.length,'OPEN PULL REQUESTS','#5eead4'],[588,data.projects,'EXTERNAL PROJECTS','#8fc7ff']]) {
    summary += text(x,81,38,color,String(value),'font-weight="700"') + text(x,105,10,'#b4c4d6',label,'letter-spacing="1.2"');
  }
  summary += text(24,136,10,'#90a4ba','Checked ' + date(checkedOn) + ' · Scheduled refresh every 6 hours');
  files.set('overview.svg',svg(880,154,'Public contributions: ' + data.merged.length + ' merged by others; ' + data.open.length + ' open; ' + data.projects + ' external projects',summary));
  const section = (items, kind) => {
    if (!items.length) return kind === 'merged' ? 'My next merged contribution will appear here automatically.\n' : 'No open pull requests right now. New contributions will appear here automatically.\n';
    return '<p align="left">\n' + items.slice(0,4).map((pr,i)=>{
      const name = kind + '-' + (i+1) + '.svg';
      files.set(name,card(pr,kind === 'merged'));
      return '  <a href="' + escapeXml(pr.url) + '"><img src="./assets/contributions/' + name + '" width="400" alt="' + escapeXml((kind === 'merged' ? 'Merged' : pr.draft ? 'Draft' : 'Open') + ': ' + pr.repository + ' #' + pr.number + ' — ' + pr.title) + '" /></a>';
    }).join('\n') + '\n</p>\n';
  };
  let markdown = START + '\n### Open-source contributions\n\nPublic pull requests in other people’s repositories. Merged cards show contributions merged by someone other than me; open cards show upcoming work awaiting a decision.\n\n';
  markdown += '<img src="./assets/contributions/overview.svg" width="100%" alt="' + data.merged.length + ' merged contributions, ' + data.open.length + ' open pull requests, across ' + data.projects + ' external projects" />\n\n';
  markdown += '#### Merged contributions\n\n' + section(data.merged,'merged') + '\n#### Upcoming · open pull requests\n\n' + section(data.open,'open');
  markdown += '\n[Explore all my public contributions](https://github.com/pulls?q=' + encodeURIComponent('is:pr is:public author:' + user + ' -user:' + user) + ') · Cards refresh automatically every 6 hours.\n\n' + END;
  return { files, markdown };
}

export function replaceSection(readme, section) {
  const start = readme.indexOf(START), end = readme.indexOf(END);
  if (start < 0 || end <= start || readme.indexOf(START,start+1) !== -1 || readme.indexOf(END,end+1) !== -1) throw new Error('Missing or duplicate contribution markers');
  return readme.slice(0,start) + section + readme.slice(end+END.length);
}

async function main() {
  const user = process.env.PROFILE_USER || 'Golden007-prog';
  const inputIndex = process.argv.indexOf('--input');
  const pulls = inputIndex >= 0 ? JSON.parse(await readFile(process.argv[inputIndex+1],'utf8')) : await collectPulls(user);
  const data = classify(pulls,user);
  const generated = render(data,user,new Date().toISOString().slice(0,10));
  const readme = await readFile('README.md','utf8');
  const updated = replaceSection(readme,generated.markdown);
  const directory = 'assets/contributions';
  await mkdir(directory,{recursive:true});
  for (const [name,content] of generated.files) await writeFile(directory + '/' + name,content);
  for (const name of await readdir(directory)) {
    if (/^(merged|open)-\d+\.svg$/.test(name) && !generated.files.has(name)) await unlink(directory + '/' + name);
  }
  await writeFile('README.md',updated);
  console.log('Updated cards:',data.merged.length,'merged,',data.open.length,'open,',data.projects,'projects');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}

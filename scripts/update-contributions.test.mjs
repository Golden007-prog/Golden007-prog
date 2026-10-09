import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, collectPulls, render, replaceSection } from './update-contributions.mjs';

const user = 'Golden007-prog';
const sample = (extra={}) => ({
  number:12, title:'fix: improve keyboard navigation', html_url:'https://github.com/community/project/pull/12',
  user:{login:user}, base:{repo:{full_name:'community/project',private:false,owner:{login:'community'}}},
  state:'open', draft:false, merged:false, merged_at:null, updated_at:'2026-10-09T05:00:00Z', ...extra
});
const accepted = sample({state:'closed',merged:true,merged_at:'2026-10-09T06:00:00Z',merged_by:{login:'maintainer'}});

test('includes only public external contributions and excludes self-merges and closed unmerged work',()=>{
  const excluded = [
    sample({base:{repo:{full_name:'community/project',private:true,owner:{login:'community'}}}}),
    sample({base:{repo:{full_name:'Golden007-prog/project',private:false,owner:{login:user}}}}),
    sample({user:{login:'someone-else'}}),
    sample({state:'closed'}),
    {...accepted,merged_by:{login:user.toUpperCase()}}
  ];
  assert.equal(classify(excluded,user).merged.length,0);
  assert.equal(classify(excluded,user).open.length,0);
  assert.equal(classify([accepted],user).merged[0].mergedBy,'maintainer');
});

test('an accepted open PR moves to merged and duplicate search entries do not duplicate cards',()=>{
  assert.equal(classify([sample()],user).open.length,1);
  const updated = classify([accepted,accepted],user);
  assert.equal(updated.open.length,0);
  assert.equal(updated.merged.length,1);
  assert.equal(updated.projects,1);
});

test('escapes untrusted titles and keeps draft status distinct from accepted work',()=>{
  const data = classify([sample({draft:true,title:'<script>alert("x")</script> & review'})],user);
  const result = render(data,user,'2026-10-09');
  const svg = result.files.get('open-1.svg');
  assert.ok(svg.includes('DRAFT'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('prefers-reduced-motion'));
  assert.ok(result.markdown.includes('Draft:'));
});

test('limits featured cards while retaining truthful totals and handles empty states',()=>{
  const list = Array.from({length:6},(_,i)=>sample({number:i+1,html_url:'https://github.com/community/project/pull/'+(i+1)}));
  const result = render(classify(list,user),user,'2026-10-09');
  assert.equal([...result.files.keys()].filter(x=>x.startsWith('open-')).length,4);
  assert.ok(result.files.get('overview.svg').includes('6 open'));
  assert.ok(render(classify([],user),user,'2026-10-09').markdown.includes('No open pull requests'));
});

test('preserves profile content outside the generated section and fails if markers are damaged',()=>{
  const original = 'before\n<!-- CONTRIBUTION-CARDS:START -->old<!-- CONTRIBUTION-CARDS:END -->\nafter';
  assert.equal(replaceSection(original,'NEW'),'before\nNEW\nafter');
  assert.throws(()=>replaceSection('No markers','NEW'));
});

test('checks actual PR state after search and rejects incomplete search responses',async()=>{
  let requests = 0;
  const pulls = await collectPulls(user,async path=>{
    requests++;
    if(path.startsWith('/search/')) return {total_count:1,incomplete_results:false,items:[{html_url:accepted.html_url}]};
    return accepted;
  });
  assert.equal(requests,3);
  assert.equal(classify(pulls,user).merged.length,1);
  await assert.rejects(()=>collectPulls(user,async()=>({incomplete_results:true,total_count:0,items:[]})),/incomplete/);
});

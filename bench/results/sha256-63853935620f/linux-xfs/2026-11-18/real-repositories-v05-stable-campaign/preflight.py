from pathlib import Path
import hashlib,json,os,subprocess,sys
root=Path(sys.argv[1]);git=root/'bin/git'
env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_NOSYSTEM='1',GIT_NO_LAZY_FETCH='1',GIT_TERMINAL_PROMPT='0',GIT_TEMPLATE_DIR='')
def command(path,args):
 return subprocess.run([str(git),'-C',str(path)]+args,env=env,capture_output=True,check=True,timeout=180).stdout
metadata={'schemaVersion':1,'kind':'published-release-benchmark-provenance','release':'v0.5.0','releaseCommit':'4d2622f77ea8bfecc1f3fd6f1930686648990bbd','inputPins':'original v0.4 published comparisons','binaries':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'bin').iterdir() if p.is_file()},'inputs':[]}
for item in json.loads((root/'inputs.json').read_text())['repositories']:
 path=Path(item['path']);pin=item['revision']
 promisor=subprocess.run([str(git),'-C',str(path),'config','--get-regexp','remote\..*\.promisor'],env=env,capture_output=True,text=True,timeout=30)
 assert promisor.returncode in [0,1]
 assert 'true' not in promisor.stdout.lower(),('Input must not lazily fetch during measurement',item['label'])
 tree=command(path,['rev-parse',pin+'^{tree}']).decode().strip()
 entries=command(path,['ls-tree','-r','-z',pin]).split(b'\0')
 objects=[e.split(b'\t',1)[0].split(b' ')[2] for e in entries if e and e.split(b'\t',1)[0].split(b' ')[1]==b'blob']
 sizes=subprocess.run([str(git),'-C',str(path),'cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],input=b'\n'.join(objects)+b'\n',capture_output=True,env=env,check=True,timeout=180).stdout.splitlines()
 assert len(sizes)==len(objects) and all(len(line.split())==3 and line.split()[1]==b'blob' for line in sizes),('Missing pinned blob',item['label'])
 row={k:v for k,v in item.items() if k!='path'}
 row.update(tree=tree,trackedBlobs=len(objects),logicalBlobBytes=sum(int(line.split()[2]) for line in sizes),shallow=command(path,['rev-parse','--is-shallow-repository']).decode().strip()=='true',promisor=False)
 metadata['inputs'].append(row)
 print(item['label'],len(objects),row['logicalBlobBytes'],flush=True)
(root/'provenance.json').write_text(json.dumps(metadata,indent=2)+'\n')
(root/'preflight-done').touch()

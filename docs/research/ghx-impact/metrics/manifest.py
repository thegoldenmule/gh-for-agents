"""Corpus snapshot manifest: path, size, mtime, sha256; plus a manifest hash for report headers."""
import os,glob,hashlib,json,sys
root=os.path.expanduser('~/.claude/projects')
rows=[]
for f in sorted(glob.glob(root+'/**/*.jsonl',recursive=True)):
    h=hashlib.sha256()
    with open(f,'rb') as fh:
        for chunk in iter(lambda: fh.read(1<<20),b''): h.update(chunk)
    st=os.stat(f); rows.append(dict(path=f[len(root)+1:],size=st.st_size,mtime=int(st.st_mtime),sha256=h.hexdigest()))
m=hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()
json.dump(dict(manifest_sha256=m,n=len(rows),bytes=sum(r['size'] for r in rows),files=rows),open(sys.argv[1],'w'))
print(len(rows),'files',sum(r['size'] for r in rows)//2**20,'MiB manifest',m[:16])

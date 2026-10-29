def solve(A,b):
    n=len(A); M=[row[:]+[b[i]] for i,row in enumerate(A)]
    for c in range(n):
        p=max(range(c,n),key=lambda r:abs(M[r][c])); M[c],M[p]=M[p],M[c]
        for r in range(n):
            if r!=c:
                f=M[r][c]/M[c][c]; M[r]=[x-f*y for x,y in zip(M[r],M[c])]
    return [M[i][n]/M[i][i] for i in range(n)]
def ols(X,y):
    A=[[1.0]+list(map(float,x)) for x in X]; k=len(A[0])
    AtA=[[sum(a[i]*a[j] for a in A) for j in range(k)] for i in range(k)]
    Aty=[sum(a[i]*v for a,v in zip(A,y)) for i in range(k)]
    coef=solve(AtA,Aty); pred=[sum(c*v for c,v in zip(coef,a)) for a in A]
    my=sum(y)/len(y); ss=sum((v-my)**2 for v in y); se=sum((v-p)**2 for v,p in zip(y,pred))
    err=sorted(abs(v-p) for v,p in zip(y,pred))
    return coef,1-se/ss,err[len(err)//2],[v-p for v,p in zip(y,pred)]

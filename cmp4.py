import re
s = open('W:/0_proj/QR_tran/cimqr_codec.js', encoding='utf-8').read()
def extract(name):
    i = s.index('function ' + name + '(')
    depth = 0
    j = i
    instr = False
    q = ''
    while j < len(s):
        c = s[j]
        if instr:
            if c == '\\':
                j += 2
                continue
            if c == q:
                instr = False
        else:
            if c in ('"', "'"):
                instr = True
                q = c
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return s[i:j+1]
        j += 1
    return s[i:]
da = extract('decodeAttempt')
df = extract('decodeFromH')
strip = lambda x: re.sub(r'//[^\n]*', '', x)
norm = lambda x: re.sub(r'\s+', '', x)
def seg(fn, start_marker, end_marker):
    si = fn.index(start_marker)
    ei = fn.index(end_marker, si)
    return norm(strip(fn[si:ei]))
# 采样前段：灰度+降采样（decodeAttempt 的 det 部分 vs decodeFromH 无——跳过）
# 采样后段：反交织+RS+header
a_after = seg(da, '// 反交织', 'return packets;')
f_after = seg(df, '// 反交织', 'return [packet];')
print('采样后段相同:', a_after == f_after)
if a_after != f_after:
    for i in range(min(len(a_after), len(f_after))):
        if a_after[i] != f_after[i]:
            print('首个差异 @', i)
            print('  A:', a_after[max(0, i-100):i+100])
            print('  F:', f_after[max(0, i-100):i+100])
            break
    print('长度 A:', len(a_after), 'F:', len(f_after))
# 采样前段（decodeAttempt 的 tpl/hue 等 vs decodeFromH）
a_pre = seg(da, 'var tplSet = getTpls', 'for (i = 0; i < DATA_CELLS; i++) {')
f_pre = seg(df, 'var tplSet = getTpls', 'for (i = 0; i < DATA_CELLS; i++) {')
print('采样前段(tpl/hue)相同:', a_pre == f_pre)
if a_pre != f_pre:
    for i in range(min(len(a_pre), len(f_pre))):
        if a_pre[i] != f_pre[i]:
            print('首个差异 @', i)
            print('  A:', a_pre[max(0, i-100):i+100])
            print('  F:', f_pre[max(0, i-100):i+100])
            break
    print('长度 A:', len(a_pre), 'F:', len(f_pre))

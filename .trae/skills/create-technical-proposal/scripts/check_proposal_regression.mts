/**
 * 验证评审导读的合法样例、漏检反例及历史布局兼容。
 * 建立时间：2026-10-18
 * 状态：active
 * 边界：调用实际 Python 检查器；不验证技术内容或 Owner 决策。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check_proposal.py", import.meta.url));
const regression = String.raw`
import runpy, sys
m = runpy.run_path(sys.argv[1])
base = '''# 测试方案
## 评审摘要
建议按业务请求记录 audit。
|决策事项|建议结论及具体方案|其他方案|排除的选择与代价|影响面|
|---|---|---|---|---|
|审计|按请求记录|无其他可行项|放弃全量，失去汇总|请求记录|
## 名词解释
|名词|解释|语境|
|---|---|---|
|audit|记录请求处理过程|建议按业务请求记录 audit。|
## 评审记录
待评审。
## 需求追踪
请求记录对应审计功能。
## 资料来源与前提
以当前请求协议为依据。
# 1. 项目背景
业务请求需要记录。
'''
def check(text, layout='current'):
    lines = text.splitlines()
    headings, blocks, errors = m['parse_document'](lines)
    fenced = {i for a, b, _, _ in blocks for i in range(a, b + 1)}
    sections = m['unnumbered_sections'](lines, fenced)
    visible = ['' if i in fenced else line for i, line in enumerate(lines)]
    return (errors + m['check_review_front'](visible, headings, sections, layout)
            + m['check_glossary'](lines, sections, layout))
cases = [
    ('正常导读', base, False),
    ('缺少分隔行', base.replace('|---|---|---|---|---|\n', ''), True),
    ('插入资料章节', base.replace('## 名词解释', '### 资料\n来源内容。\n## 名词解释'), True),
    ('只重复词名', base.replace('|建议按业务请求记录 audit。|', '|audit|'), True),
    ('决策表漏列', base.replace('其他方案|', ''), True),
    ('决策表为空', base.replace('|审计|按请求记录|无其他可行项|放弃全量，失去汇总|请求记录|', ''), True),
    ('章节错序', base.replace('## 评审记录', '## 暂存').replace('## 需求追踪', '## 评审记录').replace('## 暂存', '## 需求追踪'), True),
    ('合法注释空白', base.replace('## 名词解释', '\n<!-- 注释 -->\n## 名词解释'), False),
    ('虚构语境', base.replace('|建议按业务请求记录 audit。|', '|不存在的完整句子。|'), True),
]
for name, text, rejected in cases:
    errors = check(text)
    assert bool(errors) == rejected, (name, errors)
    print('PASS', name)
legacy = '''# 旧稿
## 需求追踪
原需求使用 audit。
## 名词解释
|名词|解释|语境|
|---|---|---|
|audit|记录处理过程|audit|
# 1. 项目背景
原业务内容。
'''
assert not check(legacy, 'legacy'), check(legacy, 'legacy')
assert check(legacy, 'current'), '新稿不得通过历史布局'
print('PASS 历史布局免迁移及新稿拒绝旧布局')
`;
execFileSync("python3", ["-B", "-c", regression, checker], { stdio: "inherit" });

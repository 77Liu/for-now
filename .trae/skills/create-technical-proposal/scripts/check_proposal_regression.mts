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
# Exercise the actual document checker and CLI, not just navigation helpers.
import tempfile, pathlib, subprocess
trimmed = """# 小修方案
## 评审摘要
修正错误提示，保持原认证和数据行为；无新增待决项。
## 资料来源与前提
依据当前接口约定；这里只核对格式，业务需要独立审查。
# 3. 详细方案设计
## 3.6 代码设计
### 3.6.2 核心伪代码
以下为类 TS 伪代码，辅助类型由工程提供。
~~~typescript
async function save(input: Input): Promise<Result> {
  await validate(input);
  return await persist(input);
}
~~~
# 4. 开发测试
## 4.1 开发明细
## 4.2 测试方案
核对合法输入及失败后原数据不变；本稿未执行测试。
"""
with tempfile.TemporaryDirectory() as temp:
    doc = pathlib.Path(temp) / 'proposal.md'
    def doc_errors(value, layout='trimmed', stage='review'):
        doc.write_text(value)
        return m['check_document'](doc, stage, layout)
    assert not doc_errors(trimmed), doc_errors(trimmed)
    assert doc_errors(trimmed, 'current'), '裁剪稿不能冒充完整格式通过'
    assert not doc_errors(trimmed.replace('~~~typescript', '~~~ts')), 'ts别名应支持'
    assert doc_errors(trimmed.replace('async function save(input: Input)', 'async function save(input:')), 'TS语法损坏必须拒绝'
    assert doc_errors(trimmed.replace('### 3.6.2 核心伪代码', '实现如下').replace('async function save(input: Input)', 'async function save(input:')), '合并小节不能绕过伪代码解析'
    assert not doc_errors(trimmed.replace('  await validate(input);', '  throw new Error(\"must not execute\");')), '检查器不得执行伪代码'
    assert doc_errors(trimmed.replace('## 4.1 开发明细\n', '## 4.1 开发明细\n已开发完成。\n')), 'review开发明细不能伪填'
    assert doc_errors(trimmed.replace('保持原认证', '{{未填写}}保持原认证')), '裁剪不能跳过占位符'
    assert doc_errors(trimmed.replace('## 4.2 测试方案', '## 4.2 测试方案\n## 4.2 测试方案')), '重复编号不能通过'
    assert doc_errors(trimmed + '\n~~~json\n{"ok":true}\n~~~\n'), '裁剪不能跳过JSON格式'
    assert doc_errors(trimmed.replace('~~~typescript', '~~~javascript')), '不能把未知语言冒充获准伪代码'
    assert doc_errors('# 空文档\n<!-- 无正文 -->'), '空裁剪稿不能通过'
    assert doc_errors(trimmed.replace('## 资料来源与前提', '## 名词解释\n|名词|解释|语境|\n|---|---|---|\n|目标|当前对象|虚构原句|\n## 资料来源与前提')), '可选表保留时仍检查语境'
    python_doc = trimmed.replace('~~~typescript\nasync function save(input: Input): Promise<Result> {\n  await validate(input);\n  return await persist(input);\n}', '~~~python\nasync def save(value):\n    await validate(value)\n    return await persist(value)')
    assert not doc_errors(python_doc), doc_errors(python_doc)
    assert doc_errors(python_doc.replace('async def save(value):', 'async def save(value)')), 'Python原检查不得退化'
    doc.write_text(trimmed)
    completed = subprocess.run([sys.executable, '-B', sys.argv[1], '--layout', 'trimmed', '--expect-count', '1', str(doc)], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert '需人工核对' in completed.stdout
    # Build a complete old-style document to cover all full-layout required sections.
    front = base[:base.index('# 1. 项目背景')]
    def full_document(pseudo):
        result = front
        for number, title in m['EXPECTED']:
            result += '#' * len(number.split('.')) + ' ' + number + ' ' + title + '\n'
            if number == '4.1': continue
            result += '本节约束及验证依据保持。\n'
            if number in ('3.1.1', '3.1.2'):
                result += '~~~mermaid\nflowchart LR\n A --> B\n~~~\n'
                result += '|' + '|'.join(m['TRANSACTION_COLUMNS']) + '|\n|---|---|---|---|---|---|\n|保存|单笔|单笔|账户|校验|提交后返回|\n'
            if number == '3.6.2': result += pseudo
        return result
    assert not doc_errors(full_document('~~~ts\nasync function f(input: External) { return await save(input); }\n~~~\n'), 'current')
    assert not doc_errors(full_document('~~~python\nasync def f(value):\n    return await save(value)\n~~~\n'), 'current')
print('PASS 裁剪/完整稿、真实CLI、类TS/Python语法及保留约束反例')

`;
execFileSync("python3", ["-B", "-c", regression, checker], { stdio: "inherit" });

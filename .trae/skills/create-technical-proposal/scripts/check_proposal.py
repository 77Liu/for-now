#!/usr/bin/env python3
"""Check proposal structure and formatting; technical correctness needs semantic review."""

import argparse
import ast
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys


EXPECTED = [
    ("1", "项目背景"),
    ("1.1", "背景"),
    ("1.2", "目标"),
    ("2", "总体方案设计"),
    ("2.1", "前期调研"),
    ("2.2", "系统架构"),
    ("2.2.1", "业务新流程"),
    ("2.2.2", "技术新流程"),
    ("2.3", "可选方案对比"),
    ("3", "详细方案设计"),
    ("3.1", "详细设计"),
    ("3.1.1", "生产链路"),
    ("3.1.2", "消费链路"),
    ("3.1.2.1", "消费入口"),
    ("3.2", "外部依赖"),
    ("3.3", "异常处理"),
    ("3.4", "数据实体"),
    ("3.5", "接口定义"),
    ("3.6", "代码设计"),
    ("3.6.1", "代码落点"),
    ("3.6.2", "核心伪代码"),
    ("3.6.3", "关键实现约束"),
    ("3.7", "监控告警"),
    ("3.8", "稳定性"),
    ("3.8.1", "容量与性能"),
    ("3.8.2", "一致性与幂等"),
    ("3.8.3", "降级与回滚"),
    ("3.8.4", "安全与日志"),
    ("3.9", "实验方案"),
    ("3.9.1", "开关与灰度"),
    ("3.9.2", "核心验收指标"),
    ("3.9.3", "效果观测"),
    ("4", "开发测试"),
    ("4.1", "开发明细"),
    ("4.2", "测试方案"),
    ("4.2.1", "Mock测试方案"),
    ("5", "上线方案"),
    ("5.1", "上线CheckList"),
    ("5.2", "上线依赖"),
    ("5.3", "观测方案"),
    ("5.4", "回滚方案"),
    ("5.5", "放量计划"),
]
HEADING = re.compile(
    r"^(#{1,6})[ \t]+(\d+(?:\.\d+)*)(?:[.．、])?[ \t]+(.+?)\s*$"
)
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
PLACEHOLDER = re.compile(r"\{\{[^{}\n]+\}\}|\bTODO\b|\bTBD\b|待填写|此处填写")


@dataclass
class Heading:
    number: str
    title: str
    level: int
    line: int


def normalized_title(value):
    value = re.sub(r"（[^）]*）|\([^)]*\)", "", value)
    return re.sub(r"\s+", "", value).casefold()


def parse_document(lines):
    headings, blocks, errors = [], [], []
    opened = None
    for i, line in enumerate(lines):
        fence = FENCE.match(line)
        if opened is not None:
            marker, info, start = opened
            if (
                fence
                and fence[1][0] == marker[0]
                and len(fence[1]) >= len(marker)
                and not fence[2].strip()
            ):
                blocks.append((start, i, info, "\n".join(lines[start + 1:i])))
                opened = None
            continue
        if fence:
            opened = (fence[1], fence[2].strip(), i)
            continue
        match = HEADING.match(line)
        if match:
            headings.append(Heading(match[2], match[3], len(match[1]), i))
    if opened:
        errors.append(f"第 {opened[2] + 1} 行的代码围栏未闭合")
    return headings, blocks, errors


def section_end(headings, index, line_count):
    depth = len(headings[index].number.split("."))
    for following in headings[index + 1:]:
        if len(following.number.split(".")) <= depth:
            return following.line
    return line_count


TRANSACTION_COLUMNS = [
    "处理动作", "原所在事务", "本次事务", "事务粒度", "事务内新增逻辑", "事务外与提交后",
]
REVIEW_FRONT_ORDER = ["评审摘要", "名词解释", "评审记录", "需求追踪", "资料来源与前提"]
DECISION_COLUMNS = ["决策事项", "建议结论及具体方案", "其他方案", "排除的选择与代价", "影响面"]


def table_cells(line):
    if not line.strip().startswith("|"):
        return []
    return [
        cell.strip().replace(r"\|", "|")
        for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))
    ]


def table_rows(lines, columns):
    for index, line in enumerate(lines):
        if table_cells(line) != columns:
            continue
        separator = table_cells(lines[index + 1]) if index + 1 < len(lines) else []
        if len(separator) != len(columns) or not all(
            re.fullmatch(r":?-+:?", cell) for cell in separator
        ):
            return []
        rows = []
        for following in lines[index + 2:]:
            cells = table_cells(following)
            if not cells:
                break
            if all(re.fullmatch(r":?-+:?", cell.replace(" ", "")) for cell in cells):
                continue
            rows.append(cells)
        return rows
    return []


def prose_text(value):
    return re.sub(r"\s+", "", value.replace("`", "").replace("\\", "").replace("*", ""))


def reject_json_constant(value):
    raise ValueError(f"Non-JSON constant: {value}")


def json_layout(value):
    # Keep layout/punctuation, allowing legal number and Unicode spellings.
    token = r'"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null'
    return re.sub(token, "@", value)


def unnumbered_sections(lines, fenced_lines):
    """Return real Markdown headings, excluding examples inside fenced code."""
    sections = []
    for i, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match and i not in fenced_lines:
            sections.append((i, len(match[1]), match[2]))
    return sections


def check_review_front(lines, headings, sections, layout):
    """Check current review navigation, while allowing explicit historical layout."""
    errors = []
    required = REVIEW_FRONT_ORDER if layout == "current" else ["需求追踪", "名词解释"]
    locations = {}
    for title in required:
        matches = [item for item in sections if item[2] == title]
        if len(matches) != 1 or matches[0][1] != 2:
            errors.append(f"需要且只允许一个二级标题：## {title}")
        else:
            locations[title] = matches[0][0]
    if len(locations) != len(required):
        return errors
    if layout == "legacy":
        following = next((i for i, _, _ in sections if i > locations["需求追踪"]), None)
        if following != locations["名词解释"]:
            errors.append("历史布局中 ## 名词解释 必须紧接 ## 需求追踪，且为同级标题")
        return errors
    body_start = headings[0].line if headings else len(lines)
    front_titles = [title for i, level, title in sections if i < body_start and level == 2]
    if front_titles != REVIEW_FRONT_ORDER:
        errors.append("新稿导读顺序必须为：评审摘要 -> 名词解释 -> 评审记录 -> 需求追踪 -> 资料来源与前提（技术正文前）")
    for title, start in locations.items():
        end = next((i for i, level, _ in sections if i > start and level <= 2), len(lines))
        content = re.sub(r"<!--.*?-->", "", "\n".join(lines[start + 1:end]), flags=re.S)
        if not content.strip():
            errors.append(f"评审导读“{title}”不能为空")
    start, end = locations["评审摘要"], locations["名词解释"]
    summary = lines[start + 1:end]
    rows = table_rows(summary, DECISION_COLUMNS)
    if not rows or any(len(row) != 5 or not all(row) for row in rows):
        errors.append(f"评审摘要需要五列非空决策表：{' / '.join(DECISION_COLUMNS)}")
    table_start = next((i for i, line in enumerate(summary)
                        if table_cells(line) == DECISION_COLUMNS), len(summary))
    table_end = table_start + 1
    while table_end < len(summary) and table_cells(summary[table_end]):
        table_end += 1
    after_table = re.sub(r"<!--.*?-->", "", "\n".join(summary[table_end:]), flags=re.S)
    if after_table.strip():
        errors.append("名词解释必须紧跟决策表，不能在表后插入其他内容或章节")
    introduction = re.sub(r"<!--.*?-->", "", "\n".join(summary[:table_start]), flags=re.S)
    introduction = re.sub(r"评审摘要决策表[：:]?", "", introduction).strip()
    if not introduction:
        errors.append("评审摘要决策表前需要简短业务摘要")
    return errors


def check_glossary(lines, sections, layout="current"):
    errors = []
    glossary = [item for item in sections if item[2] == "名词解释"]
    if len(glossary) != 1:
        return errors  # Heading errors are reported by check_review_front.
    start = glossary[0][0]
    end = next((i for i, level, _ in sections if i > start and level <= 2), len(lines))
    rows = table_rows(lines[start + 1:end], ["名词", "解释", "语境"])
    if not rows:
        errors.append("名词解释需使用非空的 |名词|解释|语境| 表")
    outside = prose_text("\n".join(lines[:start] + lines[end:]))
    for row in rows:
        if len(row) != 3 or not all(row):
            errors.append("名词解释每行必须包含三个非空单元格（表内竖线须转义）")
            continue
        term, _, context = row
        quote = re.search(r"“(.+)”", context)
        context = quote[1] if quote else context
        if layout == "current" and prose_text(context) == prose_text(term):
            errors.append(f"名词“{term}”的语境不能只重复词名，须引用实际原句")
        elif prose_text(context) not in outside:
            errors.append(f"名词“{term}”的语境未在本文其他章节找到原句")
    return errors


def check_readability(lines, headings, blocks, by_number, layout):
    fenced_lines = {i for a, b, _, _ in blocks for i in range(a, b + 1)}
    sections = unnumbered_sections(lines, fenced_lines)
    visible_lines = ["" if i in fenced_lines else line for i, line in enumerate(lines)]
    errors = check_review_front(visible_lines, headings, sections, layout)
    errors.extend(check_glossary(lines, sections, layout))
    for number in ("3.1.1", "3.1.2"):
        index = by_number.get(number)
        if index is None:
            continue
        start = headings[index].line
        end = section_end(headings, index, len(lines))
        rows = table_rows(lines[start + 1:end], TRANSACTION_COLUMNS)
        if not rows or any(len(row) != 6 or not all(row) for row in rows):
            errors.append(f"{number} 需要六列非空事务陈述表：{' / '.join(TRANSACTION_COLUMNS)}")

    for a, b, lang, body in blocks:
        stripped = body.strip()
        value = None
        try:
            value = json.loads(stripped, parse_constant=reject_json_constant)
        except (ValueError, TypeError):
            if lang.casefold() == "json":
                errors.append(f"第 {a + 1} 行 JSON 无法解析，不得使用注释或省略号")
        if lang.casefold() == "json" or isinstance(value, (dict, list)):
            if lang != "json":
                errors.append(f"第 {a + 1} 行 JSON 示例必须使用小写 json 围栏")
            if value is not None:
                formatted = json.dumps(value, ensure_ascii=False, indent=2)
                if json_layout(stripped) != json_layout(formatted):
                    errors.append(f"第 {a + 1} 行 JSON 必须逐行展开并使用 2 空格缩进")

        for number in ("3.4", "3.6.2"):
            index = by_number.get(number)
            if index is None:
                continue
            start = headings[index].line
            end = section_end(headings, index, len(lines))
            if not start < a < b < end:
                continue
            if number == "3.6.2" and lang not in ("mermaid", "json"):
                if lang != "python":
                    errors.append(f"第 {a + 1} 行核心伪代码必须使用小写 python 围栏")
                else:
                    try:
                        ast.parse(body)
                    except SyntaxError as exc:
                        errors.append(f"第 {a + 1 + (exc.lineno or 1)} 行伪代码不符合 Python 语法：{exc.msg}")
            if number == "3.4" and lang != "mermaid":
                for offset, line in enumerate(body.splitlines(), a + 2):
                    code = re.sub(r"""(["'])(?:\\.|(?!\1).)*?\1""", '""', line)
                    code = re.sub(r"//.*$|#.*$", "", code)
                    fields = re.findall(r"(?:^|[;,{])\s*[\w$]+\??\s*:", code)
                    inline_object = re.search(r"\{[^{}]*:[^{}]*\}", code)
                    if len(fields) > 1 or inline_object:
                        errors.append(f"第 {offset} 行数据实体需每字段独占一行，嵌套对象也需展开")

    pseudo_index = by_number.get("3.6.2")
    if pseudo_index is not None:
        start = headings[pseudo_index].line
        end = section_end(headings, pseudo_index, len(lines))
        if not any(start < a < b < end and lang == "python" and body.strip()
                   for a, b, lang, body in blocks):
            errors.append("3.6.2 需要非空 Python 伪代码")

    for i, line in enumerate(lines):
        if i in fenced_lines:
            continue
        # Inline code and bare table cells containing JSON objects/arrays.
        candidates = re.findall(r"`([^`\n]+)`", line)
        candidates += [cell for cell in table_cells(line) if cell.startswith(("{", "["))]
        if line.strip().startswith(("{", "[")):
            candidates.append(line.strip())
        for candidate in candidates:
            try:
                value = json.loads(candidate)
            except ValueError:
                continue
            if isinstance(value, (dict, list)):
                errors.append(f"第 {i + 1} 行 JSON 示例须移至独立 json 围栏")
                break
    return errors


def check_document(path, stage, layout="current"):
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return [f"无法读取 UTF-8 文档：{exc}"]
    lines = text.splitlines()
    headings, blocks, errors = parse_document(lines)
    by_number = {}
    previous_key = ()
    for i, heading in enumerate(headings):
        key = tuple(map(int, heading.number.split(".")))
        if key <= previous_key:
            errors.append(f"第 {heading.line + 1} 行的章节编号重复或顺序错误：{heading.number}")
        previous_key = key
        if heading.number in by_number:
            continue
        by_number[heading.number] = i
        if key[0] <= 5 and heading.level != len(key):
            errors.append(f"{heading.number} 标题层级应为 {len(key)}")

    for number, title in EXPECTED:
        index = by_number.get(number)
        if index is None:
            errors.append(f"缺少章节：{number} {title}")
            continue
        heading = headings[index]
        if normalized_title(heading.title) != normalized_title(title):
            errors.append(f"{number} 标题应为“{title}”，可保留必填等括号标注")
        end = section_end(headings, index, len(lines))
        body = "\n".join(lines[heading.line + 1:end])
        if number == "4.1" and stage == "review":
            if body.strip():
                errors.append("评审阶段 4.1 开发明细必须完全留空，只保留标题")
            continue
        has_children = (
            index + 1 < len(headings)
            and headings[index + 1].number.startswith(number + ".")
        )
        content = re.sub(r"<!--.*?-->", "", body, flags=re.S)
        substantive = re.sub(r"[\s|:#>*`~\-\[\]]", "", content)
        if not has_children and not substantive:
            errors.append(f"章节 {number} 内容为空")

    # Additional detailed subsections must contain content as well.
    expected_numbers = {number for number, _ in EXPECTED}
    for index, heading in enumerate(headings):
        if heading.number in expected_numbers:
            continue
        end = section_end(headings, index, len(lines))
        if not "\n".join(lines[heading.line + 1:end]).strip():
            errors.append(f"补充章节 {heading.number} 内容为空")

    for i, line in enumerate(lines):
        if PLACEHOLDER.search(line):
            errors.append(f"第 {i + 1} 行含未替换占位符或 TODO/TBD")
        if re.match(r"^#{1,6}\s+\d+(?:\.\d+)*\.x\b", line):
            errors.append(f"第 {i + 1} 行的小节 x 未替换为实际编号")
    for number in ("3.1.1", "3.1.2"):
        index = by_number.get(number)
        if index is None:
            continue
        start = headings[index].line
        end = section_end(headings, index, len(lines))
        if not any(
            start < a < b < end and lang == "mermaid" and body.strip()
            for a, b, lang, body in blocks
        ):
            errors.append(f"{number} 需要非空 Mermaid 链路图")
    errors.extend(check_readability(lines, headings, blocks, by_number, layout))
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=("review", "post-development"), default="review")
    parser.add_argument(
        "--layout", choices=("current", "legacy"), default="current",
        help="current 检查新评审导读；legacy 仅用于生效前既有稿，不要求回溯改排",
    )
    parser.add_argument("--expect-count", type=int, help="本批独立需求数量")
    parser.add_argument("documents", nargs="+", type=Path)
    args = parser.parse_args()
    if args.expect_count is not None and args.expect_count < 1:
        parser.error("--expect-count 必须大于 0")
    paths = [p.resolve() for p in args.documents]
    if len(set(paths)) != len(paths):
        parser.error("文档路径重复；每个需求必须交付独立文档")
    if args.expect_count is not None and len(paths) != args.expect_count:
        parser.error(f"需求数为 {args.expect_count}，文档数为 {len(paths)}")
    failed = False
    for path in paths:
        errors = check_document(path, args.stage, args.layout)
        if errors:
            failed = True
            print(f"FAIL {path}")
            for error in errors:
                print(f"  - {error}")
        else:
            print(f"PASS {path}")
    print("仅检查结构和格式；术语覆盖、事务边界、证据与技术可行性需另行核对。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

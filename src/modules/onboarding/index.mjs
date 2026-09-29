import { safeText, safeIso } from "../../shared/validation/index.mjs";

const ONBOARDING_QUESTIONNAIRE_VERSION = 1;
const onboardingQuestions = [
  { id: "evidence", tier: "quick", dimension: "认识世界", prompt: "面对重要判断但信息不完整时，你通常更依赖什么？", options: [{ value: "evidence", label: "先找可核对证据", insight: "重要判断倾向先核对证据" }, { value: "experience", label: "参考亲身经验", insight: "判断时重视亲身经验" }, { value: "trusted", label: "咨询可信的人", insight: "判断时重视可信关系与专业意见" }, { value: "intuition", label: "先相信直觉", insight: "信息不足时愿意先依直觉行动" }] },
  { id: "revision", tier: "quick", dimension: "认识世界", prompt: "新证据与原有观点冲突时，你更接近哪种反应？", options: [{ value: "revise", label: "尽快修正观点", insight: "新证据出现时愿意较快修正观点" }, { value: "verify", label: "继续核对再决定", insight: "观点修正前会继续交叉核对" }, { value: "retain", label: "优先保留原判断", insight: "更重视原有判断的连续性" }, { value: "context", label: "视具体问题而定", insight: "是否修正观点高度取决于具体语境" }] },
  { id: "truth_harmony", tier: "quick", dimension: "价值判断", prompt: "事实澄清可能破坏关系和谐时，你通常如何取舍？", options: [{ value: "truth", label: "优先把事实说清", insight: "事实与和谐冲突时更偏向事实清晰" }, { value: "gentle_truth", label: "换方式但仍说清", insight: "重视事实，也重视表达方式" }, { value: "harmony", label: "优先维持关系", insight: "冲突场景更重视关系稳定" }, { value: "delay", label: "等待更合适时机", insight: "倾向选择合适时机处理真实分歧" }] },
  { id: "autonomy", tier: "quick", dimension: "人生选择", prompt: "个人选择与重要关系期待冲突时，你更看重什么？", options: [{ value: "self", label: "个人自主", insight: "人生选择更重视个人自主" }, { value: "balance", label: "协商平衡", insight: "倾向在自主与关系间协商平衡" }, { value: "belonging", label: "关系与责任", insight: "人生选择更重视关系承诺" }, { value: "case", label: "看责任大小", insight: "会依据具体责任判断自主与关系的优先级" }] },
  { id: "stability", tier: "quick", dimension: "行动取向", prompt: "面对有吸引力但不确定的新机会，你通常会怎么做？", options: [{ value: "explore", label: "尽快尝试", insight: "面对机会更偏向探索" }, { value: "small_bet", label: "先做小规模试验", insight: "偏好用小规模试验管理不确定性" }, { value: "prepare", label: "准备充分再行动", insight: "行动前更重视准备与确定性" }, { value: "stability", label: "优先保持稳定", insight: "机会与稳定冲突时更偏向稳定" }] },
  { id: "achievement", tier: "quick", dimension: "人生选择", prompt: "成就与身心状态发生冲突时，你更接近哪种选择？", options: [{ value: "achievement", label: "阶段性冲刺", insight: "必要时愿意用短期身心成本换取成就" }, { value: "sustainable", label: "保持可持续", insight: "更重视可持续的成就节奏" }, { value: "wellbeing", label: "优先身心状态", insight: "冲突时更优先保护身心状态" }, { value: "meaning", label: "取决于是否值得", insight: "愿意为有意义的目标承担成本" }] },
  { id: "control", tier: "quick", dimension: "行动取向", prompt: "遇到无法完全控制的局面时，你更倾向于？", options: [{ value: "act", label: "先找可控行动", insight: "不确定中会先寻找可控行动" }, { value: "understand", label: "先理解全局", insight: "行动前倾向先形成整体理解" }, { value: "accept", label: "接纳不可控部分", insight: "重视区分可控与不可控并接纳后者" }, { value: "support", label: "先寻求支持", insight: "压力情境下倾向先连接支持资源" }] },
  { id: "meaning", tier: "quick", dimension: "世界观", prompt: "你更接近哪种对“有意义生活”的理解？", options: [{ value: "create", label: "意义由行动创造", insight: "倾向认为意义由选择和行动创造" }, { value: "discover", label: "意义需要被发现", insight: "倾向认为意义来自对自身与世界的发现" }, { value: "relation", label: "意义来自关系", insight: "倾向从关系与贡献中理解意义" }, { value: "plural", label: "没有唯一答案", insight: "接受意义来源多元且会随阶段变化" }] },
  { id: "rules", tier: "detailed", dimension: "价值判断", prompt: "规则与具体情境冲突时，你更倾向于？", options: [{ value: "rule", label: "维护一致规则", insight: "价值判断更重视规则一致性" }, { value: "context", label: "根据情境调整", insight: "价值判断更重视具体情境" }, { value: "principle", label: "守原则但调方法", insight: "倾向保持原则并灵活调整方法" }, { value: "impact", label: "看实际影响", insight: "倾向依据实际影响调整规则" }] },
  { id: "responsibility", tier: "detailed", dimension: "价值判断", prompt: "评价一个行为时，你更看重什么？", options: [{ value: "intent", label: "行为动机", insight: "评价行为时较重视动机" }, { value: "outcome", label: "实际结果", insight: "评价行为时较重视结果" }, { value: "process", label: "过程是否正当", insight: "评价行为时较重视过程正当性" }, { value: "combined", label: "三者一起看", insight: "倾向综合动机、过程与结果" }] },
  { id: "fairness", tier: "detailed", dimension: "社会判断", prompt: "资源有限时，怎样分配更公平？", options: [{ value: "equal", label: "尽量平均", insight: "公平观更偏向平均分配" }, { value: "need", label: "优先照顾需要", insight: "公平观更偏向按需要分配" }, { value: "contribution", label: "依据贡献", insight: "公平观更偏向按贡献分配" }, { value: "hybrid", label: "保障底线后看贡献", insight: "公平观倾向底线保障与贡献并重" }] },
  { id: "freedom", tier: "detailed", dimension: "社会判断", prompt: "自由与安全难以兼得时，你更倾向于？", options: [{ value: "freedom", label: "优先自由", insight: "公共取舍中更偏向自由" }, { value: "guardrail", label: "自由加明确底线", insight: "倾向以明确底线保护自由" }, { value: "security", label: "优先安全", insight: "公共取舍中更偏向安全" }, { value: "risk", label: "按风险程度决定", insight: "自由与安全的取舍依赖风险等级" }] },
  { id: "tradition", tier: "detailed", dimension: "世界观", prompt: "传统经验与新方法冲突时，你更倾向于？", options: [{ value: "innovation", label: "优先尝试新方法", insight: "传统与创新冲突时更偏向创新" }, { value: "test", label: "小范围验证新方法", insight: "倾向通过试验连接传统与创新" }, { value: "tradition", label: "优先保留传统", insight: "更重视传统经验的连续性" }, { value: "purpose", label: "看哪种更符合目的", insight: "不预设传统或创新的固定优先级" }] },
  { id: "individual", tier: "detailed", dimension: "社会判断", prompt: "个人利益与群体利益冲突时，你更接近？", options: [{ value: "individual", label: "保护个人边界", insight: "群体取舍中更重视个人边界" }, { value: "collective", label: "承担群体责任", insight: "群体取舍中更重视共同责任" }, { value: "rights", label: "先守权利底线", insight: "倾向先保护基本权利再协商利益" }, { value: "case", label: "按影响范围判断", insight: "个人与群体的取舍依赖影响范围" }] },
  { id: "conflict", tier: "detailed", dimension: "关系方式", prompt: "出现重要分歧时，你通常更愿意？", options: [{ value: "direct", label: "直接讨论", insight: "重要分歧中倾向直接讨论" }, { value: "reflect", label: "想清楚后再谈", insight: "重要分歧中倾向先独立整理" }, { value: "mediate", label: "寻找中间方案", insight: "重要分歧中倾向寻找可接受的中间方案" }, { value: "distance", label: "先拉开距离", insight: "重要分歧中倾向先降低互动强度" }] },
  { id: "horizon", tier: "detailed", dimension: "行动取向", prompt: "做重要选择时，你通常采用多长的时间尺度？", options: [{ value: "present", label: "先解决当下", insight: "重要选择更关注当前可行动性" }, { value: "year", label: "看未来一两年", insight: "重要选择常以一至两年为尺度" }, { value: "long", label: "看长期方向", insight: "重要选择更重视长期方向一致性" }, { value: "layers", label: "同时看短中长期", insight: "倾向同时平衡短中长期影响" }] },
  { id: "failure", tier: "detailed", dimension: "成长方式", prompt: "一次明显失败后，你更自然的第一步是？", options: [{ value: "review", label: "复盘原因", insight: "失败后倾向先复盘原因" }, { value: "retry", label: "尽快再试", insight: "失败后倾向通过再次行动学习" }, { value: "recover", label: "先恢复状态", insight: "失败后倾向先恢复身心状态" }, { value: "feedback", label: "寻求外部反馈", insight: "失败后倾向先获取外部反馈" }] },
  { id: "success", tier: "detailed", dimension: "人生选择", prompt: "你更愿意用什么判断一段经历是否成功？", options: [{ value: "goal", label: "是否达成目标", insight: "更常以目标达成判断成功" }, { value: "growth", label: "是否有所成长", insight: "更常以能力和认知成长判断成功" }, { value: "experience", label: "过程是否值得", insight: "更常以过程体验判断成功" }, { value: "impact", label: "是否帮助他人", insight: "更常以对他人的积极影响判断成功" }] }
];
const onboardingInterests = ["身心状态", "学习成长", "工作创造", "技术", "商业", "关系生活", "社会观察", "哲学", "阅读", "艺术", "运动", "旅行"];
export const defaultOnboarding = { status: "pending", questionnaireVersion: ONBOARDING_QUESTIONNAIRE_VERSION, questionnaireMode: "quick", answers: {}, profile: { gender: "", region: "", occupation: "", major: "", school: "", introduction: "", works: "" }, interests: [], material: "", understanding: "", updatedAt: "" };

function onboardingQuestionIds(mode) {
  return onboardingQuestions.filter(question => question.tier === "quick" || mode === "detailed").map(question => question.id);
}

export function normalizeOnboarding(value = {}) {
  const profile = value.profile || {}, mode = value.questionnaireMode === "detailed" ? "detailed" : "quick", answers = {};
  const required = new Set(onboardingQuestionIds(mode));
  for (const question of onboardingQuestions.filter(item => required.has(item.id))) {
    const selected = safeText(value.answers?.[question.id], 40);
    if (question.options.some(option => option.value === selected)) answers[question.id] = selected;
  }
  return {
    status: ["pending", "completed", "dismissed"].includes(value.status) ? value.status : "pending",
    questionnaireVersion: ONBOARDING_QUESTIONNAIRE_VERSION,
    questionnaireMode: mode,
    answers,
    profile: {
      gender: safeText(profile.gender, 40),
      region: safeText(profile.region, 80),
      occupation: safeText(profile.occupation, 120),
      major: safeText(profile.major, 120),
      school: safeText(profile.school, 160),
      introduction: safeText(profile.introduction, 4000),
      works: safeText(profile.works, 12000)
    },
    interests: (Array.isArray(value.interests) ? value.interests : []).map(item => safeText(item, 40)).filter(Boolean).slice(0, 20),
    material: safeText(value.material, 20000),
    understanding: safeText(value.understanding, 6000),
    updatedAt: safeIso(value.updatedAt)
  };
}

function onboardingSubmission(input = {}) {
  const onboarding = normalizeOnboarding(input), required = onboardingQuestionIds(onboarding.questionnaireMode);
  const missing = required.filter(id => !onboarding.answers[id]);
  return { onboarding, missing };
}

function onboardingUnderstanding(onboarding) {
  const profileLabels = { gender: "性别", region: "地区", occupation: "职业", major: "专业", school: "学校" };
  const background = Object.entries(profileLabels).map(([key, label]) => onboarding.profile[key] ? `${label}：${onboarding.profile[key]}` : "").filter(Boolean);
  const tendencies = onboardingQuestionIds(onboarding.questionnaireMode).map(id => {
    const question = onboardingQuestions.find(item => item.id === id), option = question?.options.find(item => item.value === onboarding.answers[id]);
    return option ? `- ${question.dimension}：${option.insight}` : "";
  }).filter(Boolean);
  return [
    `问卷：${onboarding.questionnaireMode === "detailed" ? "详细版" : "快速版"}（仅作为可修正的初始线索）`,
    background.length ? `可选背景：${background.join("；")}` : "",
    onboarding.interests.length ? `当前兴趣：${onboarding.interests.join("、")}` : "",
    onboarding.profile.introduction ? `自我介绍：${onboarding.profile.introduction}` : "",
    onboarding.profile.works ? `代表作品或材料：${onboarding.profile.works}` : "",
    tendencies.length ? `初步倾向：\n${tendencies.join("\n")}` : "",
    "这些内容来自用户本次主动填写与选择，不是人格定论；后续真实记录、修改和否定拥有更高优先级。"
  ].filter(Boolean).join("\n");
}

export function onboardingContext(value) {
  const onboarding = normalizeOnboarding(value);
  if (onboarding.status !== "completed") return "（尚未完成冷启动问卷）";
  const profileLabels = { gender: "性别", region: "地区", occupation: "职业", major: "专业", school: "学校" };
  const profile = Object.entries(profileLabels).map(([key, label]) => onboarding.profile[key] ? `${label}：${onboarding.profile[key]}` : "").filter(Boolean);
  const answers = onboardingQuestionIds(onboarding.questionnaireMode).map(id => {
    const question = onboardingQuestions.find(item => item.id === id), option = question?.options.find(item => item.value === onboarding.answers[id]);
    return question && option ? `${question.prompt} ${option.label}` : "";
  }).filter(Boolean);
  return [
    profile.length ? `用户自填背景：${profile.join("；")}` : "",
    onboarding.interests.length ? `用户选择的兴趣：${onboarding.interests.join("、")}` : "",
    onboarding.profile.introduction ? `用户自我介绍：${safeText(onboarding.profile.introduction, 1200)}` : "",
    onboarding.profile.works ? `用户提供的作品或材料：${safeText(onboarding.profile.works, 2000)}` : "",
    onboarding.material ? `用户导入材料：${safeText(onboarding.material, 2000)}` : "",
    answers.length ? `用户问卷原始选择：\n${answers.join("\n")}` : "",
    onboarding.understanding ? `可修正的初始理解：\n${safeText(onboarding.understanding, 3000)}` : ""
  ].filter(Boolean).join("\n");
}

const incomplete = missing => ({ error: `还有 ${missing.length} 道必答题未完成`, code: "ONBOARDING_ANSWERS_REQUIRED", missing });

export function createOnboardingService({ repository, now }) {
  return {
    schema() {
      return {
        version: ONBOARDING_QUESTIONNAIRE_VERSION,
        modes: [
          { id: "quick", label: "快速版", questionCount: onboardingQuestionIds("quick").length },
          { id: "detailed", label: "详细版", questionCount: onboardingQuestionIds("detailed").length }
        ],
        interests: [...onboardingInterests],
        questions: onboardingQuestions.map(question => ({ id: question.id, tier: question.tier, dimension: question.dimension, prompt: question.prompt, options: question.options.map(({ value, label }) => ({ value, label })) }))
      };
    },
    preview(input) {
      const submission = onboardingSubmission(input);
      if (submission.missing.length) return incomplete(submission.missing);
      return { value: { understanding: onboardingUnderstanding(submission.onboarding) } };
    },
    async save(input) {
      if (input.status === "dismissed") return { error: "可跳过资料，但必须完成价值判断题", code: "ONBOARDING_ANSWERS_REQUIRED" };
      const submission = onboardingSubmission({ ...input, status: input.status === "completed" ? "completed" : "pending" });
      if (submission.onboarding.status === "completed" && submission.missing.length) return incomplete(submission.missing);
      if (!submission.onboarding.understanding && !submission.missing.length) submission.onboarding.understanding = onboardingUnderstanding(submission.onboarding);
      submission.onboarding.updatedAt = now();
      return { value: await repository.update(() => submission.onboarding) };
    }
  };
}

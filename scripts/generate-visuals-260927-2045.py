from pathlib import Path
from html import escape
import argparse,subprocess
A=argparse.ArgumentParser();A.add_argument('--output-dir',required=True);A.add_argument('--prepare-png',action='store_true');A.add_argument('--finish-png',action='store_true');a=A.parse_args()
OUT=Path(a.output_dir);OUT.mkdir(parents=True,exist_ok=True);TMP=Path('/private/tmp/now-260927-2045');TMP.mkdir(exist_ok=True)
BG='#f3f5f4';INK='#29312f';MUT='#707a76';LINE='#d9dfdc';PAPER='#fcfdfc';GREEN='#47675f';GOLD='#a77d35';SOFT='#e8f0ed';BLUE='#667a88';CLAY='#987665';p=[]
def rect(x,y,w,h,fill=PAPER,stroke=LINE,r=8,dash=False):p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}"'+(' stroke-dasharray="7 5"' if dash else '')+'/>')
def t(x,y,s,z=26,c=INK,b=False,serif=False):p.append(f'<text x="{x}" y="{y}" fill="{c}" font-size="{z}" font-weight="{600 if b else 400}"'+(' font-family="Songti SC, STSong, serif"' if serif else '')+f'>{escape(s)}</text>')
def lines(x,y,ss,z=25,c=MUT,gap=42):
 for i,s in enumerate(ss):t(x,y+i*gap,s,z,c)
def edge(d,dash=False,arrow=True):p.append(f'<path d="{d}" fill="none" stroke="{GREEN}" stroke-width="2"'+(' stroke-dasharray="7 6"' if dash else '')+(' marker-end="url(#tip)"' if arrow else '')+'/>')
def rule(x,y,x2):edge(f'M{x} {y} H{x2}',arrow=False)
def label(x,y,s,c=GREEN):t(x,y,s,22,c,True)
def block(x,y,w,h,title,body,c=GREEN,dash=False):
 rect(x,y,w,h,dash=dash);rect(x+20,y+25,3,26,c,c,0);t(x+37,y+47,title,29,INK,True);lines(x+24,y+90,body,24,gap=38)
def start(title,sub,audience):
 p.clear();p.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500" viewBox="0 0 2000 1500"><title>此刻 · {escape(title)} · 260927-2045</title><defs><marker id="tip" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8" fill="{GREEN}"/></marker></defs>')
 p.append('<g font-family="Inter, PingFang SC, Microsoft YaHei, sans-serif">');rect(0,0,2000,1500,BG,BG,0)
 rect(64,42,43,43,'#37433f','#37433f',8);t(73,73,'此',28,'#d8b468',True,True);t(124,73,'此刻',27,INK,True);t(214,73,audience,22,MUT);t(1680,73,'260927-2045',25,GREEN)
 rect(64,120,4,105,GREEN,GREEN,0);t(88,167,title,51,INK,True,True);t(88,213,sub,26,MUT)
def end(name,note):
 rule(64,1432,1936);t(64,1470,note,20,MUT);t(1680,1470,'2026.09.27 20:45',22,MUT);p.append('</g></svg>');(OUT/(name+'-260927-2045.svg')).write_text('\n'.join(p))

start('系统架构：模块、依赖与运行边界','按当前运行项目核对；服务端为单体 Node 应用，下列为逻辑模块，并非独立微服务。','工程视图')
# Client map
rect(64,256,1872,157)
label(86,293,'客户端 · public/index.html / app.js / styles.css')
for x,title,body in [(88,'今日','此刻 · 共参 · 每日'),(548,'所见','念起 · 书间 · 拾句 · 小物'),(1008,'所思','思绪 · 日记 · 回顾'),(1468,'我的','统计 · 账户 · 设置 · 关于')]:
 t(x,339,title,28,INK,True);t(x,379,body,23,MUT)
edge('M790 416 V450');t(822,440,'JSON API / SSE · 生产入口 HTTPS → Nginx /now/',22,GREEN)
rect(64,460,1420,595,SOFT,LINE)
label(86,499,'应用服务 · server.mjs');t(544,499,'请求身份贯穿业务、附件与日志',22,MUT)
block(86,526,442,205,'账户与访问',['邀请码注册 / scrypt 密码哈希','Cookie 会话 / 用户目录隔离','AsyncLocalStorage 请求上下文'])
block(550,526,442,205,'记录与素材',['状态 / 健康 / 捕念 / 日记 / 思绪','书籍笔记 / 善言 / 小物','发生时间、版本迁移、原文持久化'])
block(1014,526,448,205,'批注与校正',['评论 / 划线 / 追问 / 取舍','通用资源批注 + @神鸡','编辑重定位；失效批注进入漂流箱'])
block(86,751,442,272,'模型编排',['场景契约 → SP / UP → 模型调用','Lite / Mid / High / Ultra 档位','完整追问链；推理另存不回灌','流式结束校验 / 独立后台生成'],BLUE)
block(550,751,442,272,'统计与回顾',['日级趋势 / 相关线索 / 主题聚类','个人实验 / 日记回望 / 认知复盘','记录覆盖、留痕率、主动校正','Token、调用、费用与场景统计'],BLUE)
block(1014,751,448,272,'图片与附件',['健康 / 书目识别后由用户确认','小物分割、透明蒙版与手动修正','attachment-storage.mjs 统一读写','本地后端 / 私有 OSS 后端'],BLUE)
# Providers: distinct paths and deployment boundary
block(1564,460,372,172,'DeepSeek API',['由模型编排模块统一调用','文本回答 / 回望 / 复盘','Flash 图片识别'],GREEN)
block(1564,652,372,185,'阿里云视觉分割',['SegmentHDCommonImage','GetAsyncJobResult → PNG','仅小物分割；ECS RAM 角色'],GREEN)
block(1564,857,372,198,'私有 OSS 附件',['8 个附件已迁移并逐文件比对','账户前缀 + 应用鉴权读取','Bucket 私有；本地副本保留回滚'],GREEN)
edge('M1488 551 H1552');edge('M1488 744 H1552');edge('M1488 952 H1552')
t(1510,1090,'实线：已验证调用关系',20,MUT)
# Infra with clear app-wide cross cutting support
label(64,1100,'共享基础设施 · 支撑全部业务模块')
for x,w,title,body in [
(64,446,'持久化',['用户目录：store / settings / usage','账户根目录：auth.json','串行写入、原子替换、损坏保护']),
(536,446,'可观测与调用边界',['logging.mjs · trace / call 关联','系统 / 操作 / AI 审计日志','限流、费用、附件额度：已部署']),
(1008,446,'备份与恢复',['ECS RAM → OSS 一致性快照','定时备份 + 隔离恢复已验证','附件对象与备份快照分开管理']),
(1480,456,'发布与告警',['Gitee → release → systemd','readyz 检查 / 失败回滚','飞书测试、严重告警与恢复已投递'])]:block(x,1123,w,235,title,body)
t(85,1400,'生产基线 908004b50d3f；OSS 附件、限流、告警和日志增强已部署并验证。',24,GREEN)
end('系统架构','依据：当前 Codex 项目源码与 2026-09-27 生产运行验证报告。')

start('此刻，让个人记录成为长期理解','从零散的日常输入，到带依据的回答与用户校正，建立持续回访的成长场景。','产品介绍 · VC')
# investment story: problem, wedge, evidence, hypothesis
rect(64,266,588,355)
label(88,306,'切入人群 · 待验证假设',GOLD)
t(88,357,'持续阅读、写作、复盘的人',32,INK,True,True)
lines(88,409,['想留下自己的变化，','却把生活散落在日记、笔记与对话里。','下次提问，又要重新解释自己。'],26,gap=45)
rule(88,550,626);t(88,590,'核心需求：过去的记录，能参与今天的判断。',24,GREEN)
rect(684,266,1252,355)
label(710,306,'产品如何解决')
for x,n,title,body in [(710,'一','低负担留下',['状态与健康、捕念与日记','书摘、善言与小物']),
(1120,'二','带着上下文想',['共参、思考追问、日记回望','在具体原文上调用 @神鸡']),
(1530,'三','用自己的判断校正',['修改、批注、取舍与复盘','保留原文与用户反馈'])]:
 t(x,363,n,32,GOLD,True,True);t(x+45,363,title,30,INK,True);lines(x,418,body,24,gap=43)
edge('M1057 372 H1091');edge('M1467 372 H1501')
rule(710,510,1909);t(710,555,'当前差异点：记录、AI 回答与用户修正共处一条可追溯的思考链。',29,GREEN,True)
t(710,592,'长期价值假设：积累的是个人证据与校正历史；结构化个人模型仍待建设。',24,MUT)
# evidence vs next validation
block(64,653,907,295,'已经具备的产品基础',['跨状态、健康、文字与图片的记录入口已实现','批注、神鸡、日记回望、低样本复盘已实现','邀请码账户隔离、HTTPS、备份恢复已有验证','阶段：早期 MVP；运维基线已闭环，外部邀请门槛待收口'])
block(995,653,941,295,'下一轮要证明的事',['用户是否反复回来：7 日记录覆盖 + 周留存（待补）','AI 是否带来主动思考：30 日留痕率 + 主动校正','价值是否超过使用成本：付费意愿 + 单用户模型费用','关注真实复用与校正，不把自动生成数量当成成长'])
rect(64,980,1872,337)
label(89,1022,'商业化与增长 · 提案，尚未验证',GOLD)
for x,title,ss in [(89,'先验证愿付费的场景',['从阅读、写作、复盘小群体开始','人工邀请与访谈，定位重复需求','在稳定性与隐私门槛完成后试用']),
(702,'再验证可持续的收费',['个人订阅：长期回顾与深度助手','模型用量设边界，观察毛利结构','价格、套餐与转化率均待实验']),
(1315,'最后扩展长期价值',['捕念整理 → 主题写作 → 关系线索','以证据和用户确认形成个人模型','不以“越用越懂你”替代效果验证'])]:
 t(x,1078,title,29,INK,True,True);lines(x,1125,ss,25,gap=43)
t(89,1282,'待验证的长期壁垒：高质量、可修正的个人上下文，以及跨场景持续使用形成的反馈积累。',26,GREEN)
t(64,1383,'本图不主张已验证的市场规模、用户增长、营收或留存；这些数据尚未形成可引用证据。',23,MUT)
end('产品介绍','产品事实来自当前实现；客群、增长与订阅路径为讨论假设。')

start('把所见留下，把所思慢慢想清楚','此刻，陪你记下一天，也陪你重新看见自己。','核心体验 · 给使用者')
# Each vignette combines need with a small, truthful illustrative product surface.
rect(64,270,908,509);rect(996,270,940,509)
label(88,311,'念起 · 随手记下',GREEN);t(88,365,'还没想清楚，也可以先留下。',37,INK,True,True)
lines(88,414,['一句突然冒出的念头，不必立刻变成完整的问题。','等你想继续时，再把它带进思考。'],26,gap=40)
rect(93,492,850,225,'#f8faf9');label(115,531,'一条捕念',GREEN)
t(115,581,'“我是不是总把忙碌，当作有进展？”',30,INK,False,True)
t(115,626,'# 工作  # 自我观察',23,MUT);rule(115,650,919);t(115,688,'留在念起',24,GREEN);t(750,688,'带入思考 →',24,GREEN)
label(1020,311,'思绪 · 一起深究',BLUE);t(1020,365,'一个回答，可以继续问下去。',37,INK,True,True)
lines(1020,414,['带着你的原始想法和已有追问继续讨论。','哪里不认同，就划下来，和神鸡再想一层。'],26,gap=40)
rect(1025,492,882,225,'#f8faf9');label(1047,531,'选中一句话 · @神鸡',GOLD)
rect(1047,554,695,44,'#e3eee7','#e3eee7',4);t(1061,585,'“做得更多，就代表做得更好吗？”',29,INK,False,True)
t(1047,632,'可以检查前提、找反例，也可以补充自己的看法。',24,MUT)
t(1047,686,'你的批注和追问，会和这条思考一起留下。',24,GREEN)
rect(64,807,908,509);rect(996,807,940,509)
label(88,849,'书间 · 拾句 · 小物',GOLD);t(88,903,'读过的、遇见的，都有安放处。',37,INK,True,True)
lines(88,952,['记下阅读笔记，收藏一句话，留住一张小票。','它们可以带着日期、备注和你的感受再次出现。'],26,gap=40)
for x,w,title,ss in [(93,270,'书间',['书摘与自己的思考','随机回看笔记']), (378,270,'拾句',['记下原句与出处','让好句子再相逢']), (663,280,'小物',['原图与透明轮廓','保存物件的故事'])]:
 rect(x,1037,w,213,'#f8faf9');t(x+18,1084,title,30,INK,True,True);lines(x+18,1138,ss,23,gap=42)
label(1020,849,'日记 · 回顾',CLAY);t(1020,903,'过些时候，再看看走过的自己。',37,INK,True,True)
lines(1020,952,['日记先保留你的原话，需要时再请 AI 回望。','从身体状态与思考轨迹中寻找线索，不急着下结论。'],25,gap=40)
rect(1025,1037,882,213,'#f8faf9');label(1047,1079,'不必等到记录很多，才开始回看',CLAY)
lines(1047,1130,['记录少时，先看到初步观察与还缺什么。','有新发现，也能继续编辑、补充和纠正。'],26,INK,44)
t(1047,1220,'AI 的理解可以改变，你的原文不会被悄悄改写。',25,GREEN)
t(64,1386,'从今天的一点感受开始。记录不需要完整，答案也不必一次就对。',32,GREEN,False,True)
end('核心体验','界面片段为功能示意，引用内容为虚构示例，不含用户真实记录。')

start('开发路线：先收口，再扩展','把工作拆成可验收的结果。状态依据当前代码、README-TODO 与运行验证报告。','内部规划 · 开发与优化')
# prioritized action matrix
rect(64,265,1872,93,SOFT,SOFT)
t(89,305,'当前技术发布：GO',29,GREEN,True);t(680,304,'生产 908004b50d3f ｜ 运维增强已部署验证',26,INK)
t(89,340,'保持生产基线，先完成外部邀请所需的隐私路径，再验证内容复用和长期价值。',23,MUT)
headers=[(90,'优先级 / 状态'),(347,'要完成什么'),(1067,'完成条件 / 验收')]
for x,s in headers:label(x,405,s)
rows=[
('P0','已完成',GREEN,'OSS 附件迁移 + 告警真实投递',['私有桶、RAM 读写与应用 OSS 后端已启用','8 个附件逐文件校验；本地副本保留回滚'],['上传 / 鉴权读 / 匿名拒绝 / 删除均通过','测试、服务严重告警与恢复通知均送达']),
('P0','外部邀请前',GOLD,'完成隐私与数据退出路径',['明确运营主体、联系入口、第三方与备份周期','落实同意记录、退出、导出和账户删除流程'],['隐私文档中的邀请阻断项逐条关闭','确认云端、附件、审计和备份的处理边界']),
('P1','稳定性',GREEN,'失败可恢复，记录不串写、不丢失',['覆盖编辑 / 删除 / 流式中断 / 上传失败 / 模型失败','补充证书续期、部署结果通知与发布门槛'],['API + UI 回归通过；账户隔离和断流路径受测','健康检查、回滚、恢复演练可重复执行']),
('P2','体验实验',BLUE,'先让已有记录被再次使用',['捕念批量整理；日记周期回望；低样本复盘校准','结合真实使用反馈迭代，不先扩张模块数量'],['验证记录覆盖、回访、留痕率与主动校正','新增整理、回望操作可追溯且保留原文']),
('P2','后续拓展',BLUE,'主题写作 → 有证据的关系线索',['材料归集、观点版本、大纲与引用来源','捕念图谱 / 发散建议保留时间、证据和置信度'],['一条思考可发展为带来源的主题草稿','关系能被纠正、合并和删除，不自动确认为事实'])]
for i,(priority,state,color,title,body,gate) in enumerate(rows):
 y=430+i*173;rect(64,y,1872,158)
 t(90,y+48,priority,32,color,True);t(90,y+89,state,24,color)
 t(347,y+45,title,28,INK,True);lines(347,y+87,body,23,gap=36)
 lines(1067,y+49,gate,24,INK,42)
rect(64,1322,1872,77,'#eef2f0','#eef2f0');t(88,1368,'暂不抢跑：自动部署、习惯系统、结构化数字分身；先通过发布门槛与真实使用验证。',27,GREEN,True)
end('产品路线图','优先级细化与验收为本版建议；不改变现有部署授权规则，不构成上线排期承诺。')

if a.prepare_png:
 for f in OUT.glob('*-260927-2045.svg'):
  s=f.read_text().replace('height="1500" viewBox="0 0 2000 1500"','height="2000" viewBox="0 0 2000 2000"',1).replace('<g font-family=','<g transform="translate(0 250)" font-family=',1)
  (TMP/f.name).write_text(s)
if a.finish_png:
 for f in TMP.glob('*.svg.png'):
  subprocess.run(['sips','--cropToHeightWidth','1500','2000',str(f),'--out',str(OUT/f.name.replace('.svg.png','.png'))],check=True,capture_output=True)
print(OUT)

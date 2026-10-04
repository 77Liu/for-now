# R8 素材与生成记录

2026-10-04。使用内置 imagegen；横竖背景以用户认可的 R7 山水为风格参考重构，竹影新生成。均为本机素材，无文字或用户记录。

| 文件 | 格式与尺寸 | 用途 |
|---|---|---|
| app-background-desktop.png | RGB 1672×941 | 桌面全页山水 |
| app-background-mobile.png | RGB 941×1672 | 手机全页山水 |
| bamboo-edge.png | RGBA 1024×1536，已确认透明通道 | 桌面边缘/空态 |
| vase.png / note.png / bird.png | 沿用 R7 已有示例 | 小物摆放示例 |

背景中留出大幅浅色纸面，山水集中底部；CSS 根据场景调浓度，不能把背景图当局部 hero。加载失败回退纸白，装饰不承担产品信息。没有额外独立宣纸纹理，避免纹理堆叠。尺寸、裁切、透明度、层级与无图回退见《设计与开发交接》。

## 精确生成提示词

### desktop

Use case: style-transfer. Asset type: full-page desktop app background, landscape 16:9. Input image is a style and painting reference only. Preserve its beautiful delicate celadon spring-green Song-inspired mineral ink landscape, spacious lake, layered mountains, bamboo and luminous morning mist. Recompose it as a whole screen environment that can sit behind readable text: the central 75% width and upper 70% height should be very pale near-white luminous paper and barely perceptible mist, almost empty. A shallow panoramic lake and delicate distant green mountain silhouettes run along the bottom 20%, fading upward seamlessly into paper. Taller mountain detail only on far lower right, small bamboo at far left lower edge. No visible rectangular inset, no frame. Bright fresh greens, no brown/antique yellow tint, no blue, no dark mountain blocks. Sophisticated paper and pigment texture, very light, airy, alive, mature; no text, no UI, no objects like cups or notebooks, no people, no watermark.

### mobile

Use case: style-transfer. Asset type: full-screen mobile app background, portrait 9:16. Input image is only a style and painting reference. Keep the elegant pale celadon green Song-inspired mountain lake painting and luminous natural morning light. Compose for a phone: the entire middle 80% of screen is extremely pale near-white paper mist with no scenery beneath reading. A narrow distant lake and pale green hills fill the bottom 15% edge, most detail at far lower right and lower left. A few extremely light bamboo leaves at the very upper right corner, never a dense plant. Landscape rises no higher than bottom 22%. Seamless natural atmosphere, no inset border or framed image. Clean warm-neutral paper white (not yellow), fresh light greens, delicate traditional pigment detail. No text, buttons, UI, objects, people, watermark, dark ink blocks, blue or purple.

### bamboo

Use case: stylized-concept. Asset type: transparent decorative app illustration. A single elegant sparse bamboo branch descending softly from the upper right corner, refined Song dynasty inspired light green ink and mineral pigment on an actually transparent background. Two slender airy stems, a handful of small leaves, mature painterly detail, thin lines and luminous celadon / fresh leaf green. Vertically arranged, wide empty transparent space to the left and below; branch occupies only the upper and right half. Very light natural pigment, no black ink, no grey muddy cast, no brown, no cartoon outlines, no text, no pot, no frame, no paper background. This is an edge ornament for a private reading room UI, restrained and light, not a logo.

## V0.5.6 发布派生

原图 SHA-256：

- desktop：`7bc8a03aed688c788fb5ff5a2a841ac492f2eed1df6861ed8f142325f5bb1d24`
- mobile：`cc5623b7528265d3a1359dd170279544ebcc1f84f5889f5edc5b5a500e3acb28`
- bamboo：`c3a7eda6ace0cb0de81b815bc857b8bc799e7073ca9d0244530a5d6469da753d`

发布目录 `public/assets/r8/` 保留优化 PNG 回退，并生成带内容指纹的 WebP 与
AVIF。WebP/AVIF 单文件均不超过 32 KiB；浏览器优先读取 AVIF，其次 WebP，
失败时回退 PNG 或纸白背景。竹影发布尺寸为 310px 宽，避免把原始 1024×1536
装饰图送入首屏。

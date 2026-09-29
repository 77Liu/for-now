# 首页 v0.2 背景资产

两张为内置 image_gen 新生成的独立背景（并非截图裁切），只含浅色山水/竹影与纸底；不含 UI、文字、按钮、图表或用户资料。

| 文件 | 实际尺寸 | 大小 | 使用 |
| --- | --- | --- | --- |
| desktop-background.png | 1536 × 1024 | 1,300,712 bytes | 桌面和平板，左缘疏竹、底部山水 |
| mobile-background.png | 863 × 1822 | 891,340 bytes | ≤760px 手机，右上疏竹、底部山水 |

模型未严格按请求的手机像素数输出，以上是文件实测尺寸。PNG 可直接使用；本次未对生成图像做后期编辑。

CSS 基线：纸色 `#faf9f5`，装饰背景 `center bottom / cover no-repeat`，不设文字在图内，不参与命中测试。换端使用 media query 单独切换文件；在实际设备上检查裁切与文字区域。背景本身已很浅，不应再次提高对比度或添加黑色遮罩。若某种裁切使纹理靠近正文，可在页面容器使用纸色薄层降低视觉干扰。

SHA-256：

```text
desktop-background.png 3932e095fd438bc3c952b162d4790b9019828a183b941bf45711fec232946169
mobile-background.png  1b70243bb2ec792420b3e0b1e502a0fc89ddc09367f8b597f988af1504d64109
```

完整提示词见 [generation-prompts.md](generation-prompts.md)。小物示意在原型 HTML 内用 SVG/CSS 绘制，未烘焙进背景；正式以用户真实小物图替换。

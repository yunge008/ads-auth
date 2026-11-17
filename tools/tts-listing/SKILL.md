---
name: tts-listing
description: TikTok Shop 饰品批量上架（ARTPHRO）。输入定价表 + 图片压缩包 (+ 商品表导出 / 上传模板 / listing SKU 表)，自动压缩上传图片、按已有 listing 风格写多语言标题描述、生成 Seller Center 批量上传 Excel，或经 API 建草稿。用户说「上架」「新建 listing」「生成上传表」「建草稿」时使用。
---

# TikTok Shop 上架（Claude / Codex 通用）

脚本都在 `tools/tts-listing/`，Python 3.10+，依赖 `openpyxl`、`Pillow`。工作目录建议 `tools/tts-listing/work/`（已 gitignore）。
执行者（Claude / Codex）负责：看图排序、对应 SKU、写标题描述 → 产出 listing spec JSON；其余全部由脚本完成。

## 0. 已确认的业务口径（2026-11-17 负责人）— 不要自行改

| 项 | 口径 |
|---|---|
| 定价行 | 只取「渠道 = TTS-SEA」；TH 用「TH (关税版)」；JP sheet 里站点写 PH 的行忽略 |
| SKU 键 | SKU1 + SKU3 + SKU4 + SKU5 用 `+` 连接 = 商家 SKU；SKU2 = 包装 |
| 默认包装 | PH / TH = B2；MY / SG / VN = B4（JP 未定，需问） |
| 售价 | 日常价 × 2（VN 的日常价列 = 第 2 行「提价-日常价」） |
| 库存 | 1000，写在「The Chinese mainland Pickup Warehouse」 |
| 上架方式 | API 只建草稿（`AS_DRAFT`，后端闸门强制），人工在 Seller Center 审核发布；JP 走 Excel |
| 图片 | 子文件夹 = SPU；序号 1 = 主图、2 = 佩戴图，其后由执行者建议顺序；`未使用` 开头跳过 |

## 1. 准备数据

```bash
cd tools/tts-listing
python3 pricing.py <定价表.xlsx> -o work/prices.json          # 打印各站点冲突/缺价，冲突 SKU 不取值
python3 refs.py <各站点 商品表.xlsx ...> -o work/refs.json     # 已有 listing（标题/描述/属性/包裹/变体写法）
python3 images.py <图片包.zip> -o work/images                  # 压缩 + manifest.json + sheets/<SPU>.jpg 缩略图总览
```

## 2. 每个 SPU 写 listing spec（执行者的工作）

1. **看图**：读 `work/images/sheets/<SPU>.jpg` 与 manifest 里的文件名说明（caption），必要时打开单图。
2. **图集顺序**（≤ 9 张）：主图（白底全貌）→ 佩戴图 → 细节特写 → 尺寸图 → 场景/平铺 → 其他佩戴 → 对比/多色。重复度高的、与本 listing SKU 不符的（如别的款式/颜色）舍弃。
3. **SKU 列表**：有 listing SKU 表就严格按表；没有就取定价表里以该 SPU 开头、无 `+` 组合、且在目标站点默认包装下有价格的 SKU，并与图片对应。图片包里的变体图 SKU 名与定价表不一致时（如 `AR140-B45` ↔ `AR140`），按含义对应，并写进 `_notes`。
4. **变体**：名称/取值沿用该 SPU 在各站点已有 listing 的写法（refs.json 的 `variation`），用目标语言；最多 2 级（Excel 模板限制）；变体图挂第 1 级。
5. **标题**：25–255 字符，以 `ARTPHRO` 开头，写清 款式 + 材质 + 适用人群 + 关键卖点；同一 listing 各站点含义一致。禁止：夸大/绝对化用语（best、No.1、100%）、未经证实的材质（真金、925 银）、他人品牌词。
6. **描述**（HTML）：沿用 refs.json 里同 SPU 已有描述的结构和措辞（定制须知 → 1 品牌 → 2 产品介绍 → 3 **变体说明（逐个 SKU 写尺寸、材质、差异）** → 4 包装 → 5 发货时效 → 6 保养）。定制/刻字须知只在含刻字 SKU 时保留。不要沿用旧描述末尾的 `<img>` 外链。
7. **语言**：PH / SG 英文；MY 马来文；TH 泰文；VN 越南文；JP 日文（模板语言以 Template 第 2 行为准）。
8. **类目 / 属性 / 包裹**：类目 ID 用已有 listing 的（项链 605280 等）；属性值用模板下拉值（中文，如 每包数量=1、场合=每日、性别=男女通用）；包裹默认沿用已有 listing。

spec 格式（`work/listings/<SPU>.json`，完整示例见 `example_spec.json`）：

```json
{"spu": "AR140", "_notes": ["..."], "category_id": "605280", "brand": "ARTPHRO (7258151153186424582)",
 "parcel": {"weight": 25, "length": 18, "width": 13, "height": 3},
 "properties": {"100347": "1", "100392": "每日", "100445": "男女通用"},
 "main_images": ["<sha>", "..."],
 "skus": [{"seller_sku": "AR140-K", "image": "<sha>"}, {"seller_sku": "AR140", "image": "<sha>"}],
 "sites": {"PH": {"title": "...", "description": "<p>...</p>", "variant_names": ["Style"],
                  "values": {"AR140-K": ["Engraving"], "AR140": ["No engraving"]}, "skip_skus": []}}}
```

## 3. 图片上传（全自动，无需用户操作）

```bash
python3 tos_upload.py --check      # 首次：验证密钥/地域/公共读
python3 tos_upload.py              # 上传全部压缩图，URL 写 work/images/urls.json（按内容哈希去重）
```
需要环境变量 `TOS_ACCESS_KEY` `TOS_SECRET_KEY` `TOS_BUCKET` `TOS_REGION`（见脚本头注释）。缺了就停下来告诉用户，不要改用别的图床。

## 4a. Excel（JP 及需要 Excel 的站点）

```bash
python3 build_excel.py --site PH --template "<PH 模板.xlsx>" --specs "work/listings/*.json" -o work/out/PH_upload.xlsx
```
产出 xlsx + `.report.json`（缺价 SKU、属性值告警）。模板必须是用户从 Seller Center 下载的对应站点模板。

## 4b. API 建草稿（SEA 站点）

```bash
export ADS_AUTH_PASSCODE=...        # 网站管理员口令
python3 api_push.py shops
python3 api_push.py push --site PH --specs "work/listings/*.json" --dry-run   # 先看请求体
python3 api_push.py push --site PH --specs "work/listings/*.json"
```
依赖 Edge Function `tts-listing`；店铺需授权 Product Basic + Product Modify 权限包。

## 5. 交付给用户

逐站点列：写入 listing 数 / SKU 数 / 缺价 SKU / 告警 / 草稿 product_id 或 Excel 路径；区分已核验与未核验。不得把未核验项说成通过。

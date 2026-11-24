// 标题旁的「?」说明：悬停 / 键盘聚焦 / 点按均可打开（Popover，手机可点）。
// 内容用 Steps（编号流程）+ Section（分组要点）+ FieldTable（字段说明）组织，避免大段文字。
import * as React from "react";
import { HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 150); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${label}说明`} className="text-muted-foreground hover:text-foreground"
          onMouseEnter={show} onMouseLeave={hide}>
          <HelpCircle className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" onMouseEnter={show} onMouseLeave={hide}
        className="w-[460px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-auto p-4 space-y-4 text-xs leading-relaxed">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-[13px] font-semibold text-foreground">{title}</h4>
      {children}
    </section>
  );
}

// 编号流程：每步一行，主句加粗短语 + 可选补充
export function Steps({ items }: { items: { t: React.ReactNode; d?: React.ReactNode }[] }) {
  return (
    <ol className="space-y-1.5">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">{i + 1}</span>
          <span><span className="font-medium text-foreground">{s.t}</span>{s.d && <span className="text-muted-foreground"> — {s.d}</span>}</span>
        </li>
      ))}
    </ol>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1 pl-4 text-muted-foreground marker:text-muted-foreground/60">
      {items.map((x, i) => <li key={i}>{x}</li>)}
    </ul>
  );
}

export function FieldTable({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i} className="border-t first:border-t-0 align-top">
            <th scope="row" className="whitespace-nowrap py-1 pr-3 text-left font-medium text-foreground">{k}</th>
            <td className="py-1 text-muted-foreground">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const B = ({ children }: { children: React.ReactNode }) => <b className="font-medium text-foreground">{children}</b>;

// 建组时后台自动做的检查：Excel / 单条 / 复制共用
const AUTO_RULES = [
  <>商品<B>下架 / 不可投</B> → 自动去掉，组照建，标「已建·需处理」</>,
  <>商品<B>已在别的启用组</B> → 整组不建（一个商品只能在一个启用组）</>,
  <>商品<B>超过 50 个</B> → 先建 50 个再自动补全；补不全标「已建·需处理」</>,
  <>促销日、自动加预算<B>一律不开</B></>,
];

export function ExcelHelp() {
  return (
    <HelpTip label="Excel 批量新建">
      <Section title="怎么用">
        <Steps items={[
          { t: "下载模板，填表", d: "一行 = 一个广告组" },
          { t: "（可选）选目标户和 BC", d: "选了就覆盖表里的广告户ID / 店铺授权BC" },
          { t: "上传文件", d: "下方预览，格式不对的行标「校验未通过」，不会执行" },
          { t: "执行创建", d: "逐行建，一行失败不影响其他行" },
          { t: "下载结果", d: "含每个商品的成功 / 失败原因" },
        ]} />
      </Section>
      <Section title="必填列">
        <FieldTable rows={[
          ["广告户ID", "页面选了目标户可留空"],
          ["广告组名称", "同一户内不要重名，便于对照"],
          ["商品ID", <>多个用逗号或换行分隔；填 <B>ALL</B> = 全店商品组</>],
          ["ROI / 预算", "大于 0 的数字"],
          ["开始 / 结束时间", <>可空（空 = 马上开始 / 不结束）；按 <B>UTC+0</B> 填，即北京时间减 8 小时</>],
        ]} />
      </Section>
      <Section title="可选列">
        <FieldTable rows={[
          ["视频账号JSON", "视频账号列表，一般由「账户复制 → 下载」生成"],
          ["新素材优先测试", "ON / OFF"],
          ["店铺授权BC", "BC ID"],
        ]} />
      </Section>
      <Section title="建组时自动处理"><Bullets items={AUTO_RULES} /></Section>
    </HelpTip>
  );
}

export function SingleHelp() {
  return (
    <HelpTip label="单条新建">
      <Section title="怎么用">
        <Steps items={[
          { t: "选广告户和店铺授权 BC", d: "提示缺店铺 / BC 信息的户先去「设置」补齐" },
          { t: "填名称、ROI、预算", d: "开始时间默认马上开始，结束时间默认不设" },
          { t: "填商品ID", d: "一行一个或逗号分隔；填 ALL = 全店商品组" },
          { t: "创建广告组", d: "结果显示在下方，也会写入「记录」" },
        ]} />
      </Section>
      <Section title="建组时自动处理"><Bullets items={AUTO_RULES} /></Section>
    </HelpTip>
  );
}

export function CopyHelp() {
  return (
    <HelpTip label="账户复制">
      <Section title="怎么用">
        <Steps items={[
          { t: "选源户 → 目标户", d: "各自选店铺授权 BC" },
          { t: "读取广告组", d: "建议先「下载」存档" },
          { t: "到 TikTok 后台把店铺授权切到目标户", d: <>需对方同意；切好后右侧显示绿色「店铺已授权为新账号」</> },
          { t: "勾选要复制的组", d: "可按「近 3 天有消耗 / 启用中」筛选" },
          { t: "读取视频账号，勾选要带的账号", d: "只能勾目标 BC 有授权的" },
          { t: "复制", d: "失败的点「重试失败」" },
          { t: "下载结果", d: "复制后才能点" },
        ]} />
      </Section>
      <Section title="复制什么">
        <FieldTable rows={[
          ["名称、商品、预算", "与源组一致"],
          ["ROI", <>取名称里 <B>R 后面的最后一个数</B>（如 R3.4-5.0 → 5.0）；取不到才用源组设置</>],
          ["视频账号", "源组有且已勾选的"],
          ["固定设置", "新素材优先测试开；立即开始"],
        ]} />
      </Section>
      <Section title="特殊情况">
        <Bullets items={[
          <><B>全店商品组</B> → 转成指定商品：取近 30 天有数据的商品，去掉其他组已有的</>,
          <><B>手选视频的组</B> → 标「手动」，不复制，需后台手建</>,
          <><B>AI 素材（审核后发布）</B> → 接口不支持，建完去后台手动开</>,
          <>没成功的组都列在上方红框里</>,
        ]} />
      </Section>
      <Section title="建组时自动处理"><Bullets items={AUTO_RULES} /></Section>
      <Section title="两个下载的区别">
        <FieldTable rows={[
          ["下载", <>读取到的源组；其中「导入」sheet 可直接拿去「Excel 批量新建」上传</>],
          ["下载结果", "复制后的结果 + 每个商品的明细"],
        ]} />
      </Section>
    </HelpTip>
  );
}

export function LogHelp() {
  return (
    <HelpTip label="导入记录">
      <Section title="看什么">
        <Bullets items={[
          "近 30 天每次新建 / 复制一行（Excel、单个、复制三种方式）",
          "末尾下载按钮：这次的商品明细",
        ]} />
      </Section>
      <Section title="数量列（成功 / 未纳入 / 失败 按商品计）">
        <FieldTable rows={[
          ["组", "这次处理的广告组数"],
          ["成功", "成功加入广告组的商品数"],
          ["未纳入", "组建成了、但没加进去的商品数（下架、不可投、补全失败等）"],
          ["失败", "所在组没建成的商品数"],
        ]} />
      </Section>
    </HelpTip>
  );
}

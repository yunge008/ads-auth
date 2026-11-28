# 达人建联登记表 替换公式（2026-11-28 第 2 版，复制表实测）

口径（负责人 2026-11-28 定，均为**变更**）：
1. 寄样按「站点 | 发样日期 | SKU | 达人」去重。
2. SKU 只看数字段：搜索 SKU 的每个数字段都出现在 K 列里就算，**组合不分先后、可夹别的款、可带字母后缀**。
   333 → 计 333-K / 333-B-K / 333BK / AR333-B / 1004、333；不计 3334 / AR3334 / 1333 / 333418（漏分隔符）。
   3120+3121 → 计 3120-K+3121-K / 3121-K+3120-K / 3120+999+3121。
   寄样、返素材、E/F 剪辑数都用这个口径。

实测：新品推广 746/746、产品推广计划 620/620 与脚本逐格一致（含 E/F）；查询格 D1 输入后约 8 秒出结果（U 列已改数值时）。

用法：以第 4 行、第 1 位同事（李汝华）为例。统计格整对（寄样+返素材）复制到右边各同事两列、再往下拉。

## 新品推广 E4（小莫 · 剪辑素材数量）；F4 把公式里的 '小莫' 改成 '王诗蔓'
=IF(OR($A4="",$B4=""),"",IFERROR(LET(dt,IMPORTRANGE("https://lnihysziqd.feishu.cn/sheets/EHmlsMg33heiiOtb4kZcvpg8nJg","'小莫'!A3:G55000"),bd,ARRAYFORMULA(IFERROR(INT(VALUE(INDEX(dt,,3))),0)),ar,ARRAYFORMULA(TRIM(INDEX(dt,,4)&"")),g,ARRAYFORMULA(TRIM(INDEX(dt,,7)&"")),k,INDEX(dt,,6),s0,INT($A4),raw,UNIQUE(FILTER({ar,g},bd>=s0,bd<=s0+29,ar<>"",g<>"",REDUCE(1,SPLIT(REGEXREPLACE(TRIM($B4&""),"[^0-9]+",","),","),LAMBDA(a,x,ARRAYFORMULA(a*ISNUMBER(SEARCH(","&x&",",","&REGEXREPLACE(TRIM(k&""),"[^0-9]+",",")&",")))))>0)),q,QUERY(raw,"select Col1,count(Col2) group by Col1 order by count(Col2) desc label count(Col2) ''",0),TEXTJOIN(CHAR(10),TRUE,INDEX(q,,1)&": "&INDEX(q,,2))),"无素材"))

## 新品推广 G4（李汝华 · 寄样数量）
=IF(OR($A4="",$B4="",G$2="",H$2=""),"",IFERROR(LET(sh,"建联-"&TRIM(G$2),b,INDIRECT("'"&sh&"'!$B$3:$B$55000"),ar,INDIRECT("'"&sh&"'!$C$3:$C$55000"),d,INDIRECT("'"&sh&"'!$D$3:$D$55000"),k,INDIRECT("'"&sh&"'!$K$3:$K$55000"),bd,ARRAYFORMULA(IFERROR(INT(VALUE(b)),0)),s0,INT($A4),st,ARRAYFORMULA(TRIM(SUBSTITUTE(SPLIT(SUBSTITUTE(H$2&"","，",","),","),CHAR(160)," "))),bs,IFERROR(FILTER({ARRAYFORMULA(TRIM(SUBSTITUTE(ar&"",CHAR(160)," "))),ARRAYFORMULA(TRIM(SUBSTITUTE(ar&"",CHAR(160)," ")))&"|"&bd&"|"&ARRAYFORMULA(TRIM(k&"")&"|"&TRIM(d&""))},bd>=s0,bd<=s0+89,ARRAYFORMULA(TRIM(d&"")<>""),REDUCE(1,SPLIT(REGEXREPLACE(TRIM($B4&""),"[^0-9]+",","),","),LAMBDA(a,x,ARRAYFORMULA(a*ISNUMBER(SEARCH(","&x&",",","&REGEXREPLACE(TRIM(k&""),"[^0-9]+",",")&",")))))>0),{"#无#","#无#"}),ra,INDEX(bs,,1),ky,INDEX(bs,,2),cn,MAP(st,LAMBDA(s,IFERROR(ROWS(UNIQUE(FILTER(ky,ARRAYFORMULA(((ra=s)+(LEFT(ra,LEN(s)+1)=s&"-"))>0)))),0))),IF(SUM(cn)=0,0,TEXTJOIN(CHAR(10),TRUE,ARRAYFORMULA(st&": "&cn)))),0))

## 新品推广 H4（李汝华 · 返素材数量）
=IF(OR($A4="",$B4="",G$2="",H$2=""),"",IFERROR(LET(sh,"建联-"&TRIM(G$2),n,INDIRECT("'"&sh&"'!$N$3:$N$55000"),ar,INDIRECT("'"&sh&"'!$C$3:$C$55000"),d,INDIRECT("'"&sh&"'!$D$3:$D$55000"),k,INDIRECT("'"&sh&"'!$K$3:$K$55000"),p,INDIRECT("'"&sh&"'!$P$3:$P$55000"),nd,ARRAYFORMULA(IFERROR(INT(VALUE(n)),0)),s0,INT($A4),st,ARRAYFORMULA(TRIM(SUBSTITUTE(SPLIT(SUBSTITUTE(H$2&"","，",","),","),CHAR(160)," "))),bs,IFERROR(FILTER({ARRAYFORMULA(TRIM(SUBSTITUTE(ar&"",CHAR(160)," "))),ARRAYFORMULA(TRIM(d&"")&"|"&TRIM(k&"")&"|"&TRIM(p&""))},nd>=s0,nd<=s0+89,ARRAYFORMULA(TRIM(p&"")<>""),REDUCE(1,SPLIT(REGEXREPLACE(TRIM($B4&""),"[^0-9]+",","),","),LAMBDA(a,x,ARRAYFORMULA(a*ISNUMBER(SEARCH(","&x&",",","&REGEXREPLACE(TRIM(k&""),"[^0-9]+",",")&",")))))>0),{"#无#","#无#"}),ra,INDEX(bs,,1),ky,INDEX(bs,,2),cn,MAP(st,LAMBDA(s,IFERROR(ROWS(UNIQUE(FILTER(ky,ARRAYFORMULA(((ra=s)+(LEFT(ra,LEN(s)+1)=s&"-"))>0)))),0))),IF(SUM(cn)=0,0,TEXTJOIN(CHAR(10),TRUE,ARRAYFORMULA(st&": "&cn)))),0))

## 产品推广计划 H4（李汝华 · 寄样数量）
=IF(TRIM($D4&"")="","",IFERROR(LET(sh,"建联-"&TRIM(H$2),x,INDIRECT("'"&sh&"'!$B$3:$B$55000"),ar,INDIRECT("'"&sh&"'!$C$3:$C$55000"),d,INDIRECT("'"&sh&"'!$D$3:$D$55000"),k,INDIRECT("'"&sh&"'!$K$3:$K$55000"),bd,ARRAYFORMULA(IFERROR(INT(VALUE(x)),0)),lo,IF(TRIM($B4&"")="",1,INT(VALUE($B4))),hi,IF(TRIM($C4&"")="",10^10,INT(VALUE($C4))),rr,UNIQUE(FILTER(ARRAYFORMULA(bd&"|"&TRIM(d&"")&"|"&TRIM(k&"")),bd>=lo,bd<=hi,ARRAYFORMULA(TRIM(SUBSTITUTE(ar&"",CHAR(160)," ")))=TRIM(SUBSTITUTE($G4&"",CHAR(160)," ")),ARRAYFORMULA(TRIM(d&"")<>""),REDUCE(1,SPLIT(REGEXREPLACE(TRIM($D4&""),"[^0-9]+",","),","),LAMBDA(a,x,ARRAYFORMULA(a*ISNUMBER(SEARCH(","&x&",",","&REGEXREPLACE(TRIM(k&""),"[^0-9]+",",")&",")))))>0)),ROWS(rr)),0))

## 产品推广计划 I4（李汝华 · 返素材数量）
=IF(TRIM($D4&"")="","",IFERROR(LET(sh,"建联-"&TRIM(H$2),x,INDIRECT("'"&sh&"'!$N$3:$N$55000"),ar,INDIRECT("'"&sh&"'!$C$3:$C$55000"),d,INDIRECT("'"&sh&"'!$D$3:$D$55000"),k,INDIRECT("'"&sh&"'!$K$3:$K$55000"),p,INDIRECT("'"&sh&"'!$P$3:$P$55000"),nd,ARRAYFORMULA(IFERROR(INT(VALUE(x)),0)),lo,IF(TRIM($B4&"")="",1,INT(VALUE($B4))),hi,IF(TRIM($C4&"")="",10^10,INT(VALUE($C4))),rr,UNIQUE(FILTER(ARRAYFORMULA(TRIM(d&"")&"|"&TRIM(k&"")&"|"&TRIM(p&"")),nd>=lo,nd<=hi,ARRAYFORMULA(TRIM(SUBSTITUTE(ar&"",CHAR(160)," ")))=TRIM(SUBSTITUTE($G4&"",CHAR(160)," ")),ARRAYFORMULA(TRIM(p&"")<>""),REDUCE(1,SPLIT(REGEXREPLACE(TRIM($D4&""),"[^0-9]+",","),","),LAMBDA(a,x,ARRAYFORMULA(a*ISNUMBER(SEARCH(","&x&",",","&REGEXREPLACE(TRIM(k&""),"[^0-9]+",",")&",")))))>0)),ROWS(rr)),0))

## 各「建联-*」表 E1（查询格）：D1 输入用户名或昵称 → E1 实时显示所有登记过的同事
每位同事一行「同事 最近发样日期 站点」，按日期从近到远；没登记过显示「未建联」。8 张建联表的 E1 都粘同一个公式（会覆盖 D1/E1 原来的「必填」字样）。
新增建联表时，把公式里 VSTACK 的表名列表补上。
=IF(TRIM(D1&"")="","",IFERROR(LET(q,TRIM(D1&""),a,VSTACK('建联-阿南'!$A$3:$E$20000,'建联-林丽洪'!$A$3:$E$20000,'建联-湘红'!$A$3:$E$20000,'建联-林乐欣'!$A$3:$E$20000,'建联-李汝华'!$A$3:$E$20000,'建联-何莎莎'!$A$3:$E$20000,'建联-陈晓桃'!$A$3:$E$20000,'建联-自动'!$A$3:$E$20000),m,SORT(FILTER(CHOOSECOLS(a,1,2,3),INDEX(a,,1)<>"",(ARRAYFORMULA(TRIM(INDEX(a,,4)&""))=q)+(ARRAYFORMULA(TRIM(INDEX(a,,5)&""))=q)),2,-1),o,UNIQUE(INDEX(m,,1)),TEXTJOIN(CHAR(10),TRUE,MAP(o,LAMBDA(x,LET(r,FILTER(m,INDEX(m,,1)=x),x&" "&TEXT(INDEX(r,1,2),"yyyy-mm-dd")&" "&INDEX(r,1,3)))))),"未建联"))

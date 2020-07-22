# appx-scanner

快速扫描支付宝小程序项目，排查低级错误。

本项目旨在解决官方工具报错不清晰、甚至没有报错导致浪费大量时间来调试的问题。

## 特性

可以扫描以下异常：

- 未定义的组件
- 组件路径和结构异常
- XML语法错误
- XML中的括号异常

## 用法

先安装 [Deno](https://deno.land/)。

然后执行：

```sh
$ deno run --allow-read https://raw.githubusercontent.com/gera2ld/appx-scanner/master/main.ts project
```

注：`project` 是 `app.json` 所在的目录。

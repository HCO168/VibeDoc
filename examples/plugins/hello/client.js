// Board tab of the hello plugin. vd.data(route) fetches once and re-renders; vd.post(route, data) writes.
VibeDoc.registerView("hello", (vd) => {
  const g = vd.data("greeting");
  if (!g) return vd.h("div", { class: "empty" }, "加载中…");
  const name = vd.h("input", { type: "text", placeholder: "名字" });
  return [
    vd.h("h2", {}, "问候"),
    vd.h("p", {}, g.text || "还没有问候"),
    name,
    vd.h("button", { class: "primary small", onclick: () => vd.post("greet", { name: name.value }) }, "写入"),
  ];
});

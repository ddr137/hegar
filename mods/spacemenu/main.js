// Space menu: what the sidebar's + button offers. Opened as a popup (openOverlay) by the `sidebar` mod.
//   Browse folder…        the system's folder picker, then a space in the folder chosen
//   New terminal in home  a space with a terminal in the home folder, at once
// Neither gives the space a name: Herdr calls it after where its first terminal is (its repo, else its folder, "~" at
// home) and the name follows the terminal: cd into a project and the space is called after it, cd back and it is "~".
// `space.new` with no folder would start in the folder of the space that is shown (and repeat its name), so home is
// passed; `machine: ""` is this computer, where the folder picker and home are.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, closeOverlay, pickFolder, home } from "herdr";

export default class SpaceMenu extends View {
  init(_props, _cx) {
    this.picking = false;
  }

  // The folder picker is a task of its own (cx.spawn); the popup stays up behind it and closes when it is done.
  browse(cx) {
    this.picking = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "Create space" });
        if (folder) run("space.new", { folder, machine: "" });
      } catch {
        // cancelled or refused: nothing to make
      }
      closeOverlay(props()?.overlay);
    });
  }

  startAtHome() {
    run("space.new", { folder: home(), machine: "" });
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    const row = (id, icon, title, hint, onClick) =>
      h_flex()
        .id(id)
        .gap(10)
        .px(10)
        .h(44)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => onClick(cx))
        .child(svg(icon).size(16).flex_none().text_color(t.dim))
        .child(
          v_flex()
            .min_w(0)
            .child(div().text_size(12.5).font_medium().text_color(t.foreground).truncate().child(title))
            .child(div().text_size(10.5).text_color(t.dim).truncate().child(hint)),
        );

    if (this.picking) {
      return h_flex()
        .px(14)
        .h(52)
        .gap(10)
        .items_center()
        .child(svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.dim).spin(900))
        .child(div().text_size(12).text_color(t.dim).child("Choosing a folder…"));
    }

    return v_flex()
      .p(4)
      .gap(2)
      .child(row("space-browse", "mods/workspace-chrome/folder-plus.svg", "Browse folder…", "Pick where the space lives", (cx) => this.browse(cx)))
      .child(row("space-home", "mods/workspace-chrome/terminal.svg", "New terminal in home", "Start in ~ right away", () => this.startAtHome()));
  }
}

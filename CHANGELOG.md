# Changelog

## 0.0.5
- Crash tracking: when `mafia2.exe` crashes (Windows Application Error log), a notification names
  the mods added or changed since the last run that worked, with a button to disable them
- Problems column on the Mods page: crashed since enabled, merge conflicts with a Conflicts button,
  and files turned off
- Files button: choose which of a mod's .sds files are used; unticked files are neither deployed nor
  merged (Vortex file overrides, now also respected by the .sds merge)
- Empty (0-byte) .sds files the deploy puts in the game are reported, and marked in the conflicts window

## 0.0.4
- Archives with several versions of the same files side by side (1080p/4K folders and the like):
  a dialog asks which one to install, instead of refusing the archive or letting the last one win

## 0.0.3
- Any .sds that two or more enabled mods replace is merged, not only tables.sds: ingame.sds, DLC files.
  Archives with models or textures can't be merged: one mod's file is used whole, by default the one
  lower in the list; the conflicts window lets you pick whose
- Rows are matched by id only when ids are unique in every version (mods that clone rows merged wrong)
- Table rows are merged field by field: different fields of one row from different mods both apply
- Merge conflicts window (Resolve in the notification, or ... on the Mods page): the conflicting
  values side by side, pick per field or a whole mod; choices are kept and used on every deploy.
  Rows are shown by their own name (Thompson 1928), columns by name where known. When every conflict
  has a choice the notification is green and its button reads Change choices instead of Resolve
- Mafia Toolkit: offered for install from its GitHub releases, set up as a tool of the game; its
  column name list is used by the conflicts window

## 0.0.2
- Plain Vortex extension instead of GDL, same installers and mod types
- `pc/sds/tables/tables.sds` is merged row by row on deploy

## 0.0.1
- First release (GDL): game detection, installers for pc/, edit/, sds/, bare .sds and ASI mods

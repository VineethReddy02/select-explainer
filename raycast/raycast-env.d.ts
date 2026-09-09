/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `ask-selection` command */
  export type AskSelection = ExtensionPreferences & {}
  /** Preferences accessible in the `saved-notes` command */
  export type SavedNotes = ExtensionPreferences & {}
  /** Preferences accessible in the `settings` command */
  export type Settings = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `ask-selection` command */
  export type AskSelection = {}
  /** Arguments passed to the `saved-notes` command */
  export type SavedNotes = {}
  /** Arguments passed to the `settings` command */
  export type Settings = {}
}


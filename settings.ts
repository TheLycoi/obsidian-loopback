/*
Settings for Loopback. Every field here is inert in this ticket: nothing
reads an API key, nothing calls AnkiConnect. The fields exist now because
the settings tab is part of the plugin shell, and later tickets (drafting,
the inbox view) read these same values instead of inventing their own.
*/

import { App, PluginSettingTab, Setting } from "obsidian";
import type LoopbackPlugin from "./main";

export type ApiKeySource = "env" | "keychain" | "vault";

export interface LoopbackSettings {
	inboxPath: string;
	apiKeySource: ApiKeySource;
	ankiConnectUrl: string;
}

export const DEFAULT_SETTINGS: LoopbackSettings = {
	inboxPath: "flashcard-inbox.md",
	apiKeySource: "env",
	ankiConnectUrl: "http://localhost:8765",
};

export class LoopbackSettingTab extends PluginSettingTab {
	plugin: LoopbackPlugin;

	constructor(app: App, plugin: LoopbackPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Inbox file path")
			.setDesc("Vault-relative path to the file that captures are appended to.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.inboxPath)
					.setValue(this.plugin.settings.inboxPath)
					.onChange(async (value) => {
						this.plugin.settings.inboxPath = value.trim() || DEFAULT_SETTINGS.inboxPath;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key source")
			.setDesc(
				"Where the drafting tool reads the model API key from, once a later version adds it. This vault syncs through iCloud, so a key stored in the vault (data.json or a note) is replicated in plaintext to every device and every backup of the vault. Prefer an environment variable or the OS keychain."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("env", "Environment variable")
					.addOption("keychain", "OS keychain")
					.addOption("vault", "In-vault (not recommended, plaintext over iCloud)")
					.setValue(this.plugin.settings.apiKeySource)
					.onChange(async (value) => {
						this.plugin.settings.apiKeySource = value as ApiKeySource;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("AnkiConnect URL")
			.setDesc("Address the export step will call. Not used by capture.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.ankiConnectUrl)
					.setValue(this.plugin.settings.ankiConnectUrl)
					.onChange(async (value) => {
						this.plugin.settings.ankiConnectUrl = value.trim() || DEFAULT_SETTINGS.ankiConnectUrl;
						await this.plugin.saveSettings();
					})
			);
	}
}

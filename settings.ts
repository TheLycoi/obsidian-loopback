/*
Settings for Loopback. Every field here is inert in this ticket: nothing
reads an API key, nothing calls AnkiConnect. The fields exist now because
the settings tab is part of the plugin shell, and later tickets (drafting,
the inbox view) read these same values instead of inventing their own.
*/

import { App, PluginSettingTab, Setting } from "obsidian";
import type LoopbackPlugin from "./main";

export type ApiKeySource = "env" | "keychain" | "vault";
export type DraftingProvider = "anthropic" | "openai-compatible";

export interface LoopbackSettings {
	inboxPath: string;
	apiKeySource: ApiKeySource;
	ankiConnectUrl: string;
	/** Which adapter drafting uses. */
	provider: DraftingProvider;
	/** The model id sent to whichever provider is selected. */
	modelId: string;
	/** The environment variable checked first when resolving the API key. */
	envVarName: string;
	/** Base URL for the OpenAI-compatible backend. Ignored for Anthropic. */
	openAiBaseUrl: string;
	/**
	 * The in-vault API key, read only when apiKeySource is "vault". Stored in
	 * data.json like every other setting, which this vault syncs through
	 * iCloud in plaintext. Left blank by default for that reason.
	 */
	vaultApiKey: string;
}

export const DEFAULT_SETTINGS: LoopbackSettings = {
	inboxPath: "flashcard-inbox.md",
	apiKeySource: "env",
	ankiConnectUrl: "http://localhost:8765",
	provider: "anthropic",
	modelId: "claude-sonnet-4-5",
	envVarName: "ANTHROPIC_API_KEY",
	openAiBaseUrl: "https://openrouter.ai/api/v1",
	vaultApiKey: "",
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

		new Setting(containerEl)
			.setName("Drafting provider")
			.setDesc("Which backend the \"Draft pending captures\" command calls.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("anthropic", "Anthropic")
					.addOption("openai-compatible", "OpenAI-compatible (OpenRouter, local servers)")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as DraftingProvider;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model id")
			.setDesc("The model id sent to the drafting provider, for example claude-sonnet-4-5 or an OpenRouter model slug.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.modelId)
					.setValue(this.plugin.settings.modelId)
					.onChange(async (value) => {
						this.plugin.settings.modelId = value.trim() || DEFAULT_SETTINGS.modelId;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key environment variable")
			.setDesc("Checked first, before the OS keychain, regardless of the API key source below.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.envVarName)
					.setValue(this.plugin.settings.envVarName)
					.onChange(async (value) => {
						this.plugin.settings.envVarName = value.trim() || DEFAULT_SETTINGS.envVarName;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("OpenAI-compatible base URL")
			.setDesc("Used only when the drafting provider above is OpenAI-compatible.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.openAiBaseUrl)
					.setValue(this.plugin.settings.openAiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.openAiBaseUrl = value.trim() || DEFAULT_SETTINGS.openAiBaseUrl;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("In-vault API key")
			.setDesc(
				"Used only when API key source above is set to vault. Stored in this plugin's data.json, which syncs through iCloud in plaintext to every device and every backup of the vault. Leave blank unless you have already accepted that cost."
			)
			.addText((text) =>
				text
					.setPlaceholder("not recommended")
					.setValue(this.plugin.settings.vaultApiKey)
					.onChange(async (value) => {
						this.plugin.settings.vaultApiKey = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

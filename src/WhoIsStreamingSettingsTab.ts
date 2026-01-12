import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import { isPluginEnabled } from "obsidian-dataview";
import WhoIsStreamingPlugin from "./main";
import { JellyfinInstance, PlexSettings } from "./settings";
import PlexApiService from "./PlexApiService";

class FolderSelectionModal extends Modal {
  folders: string[];
  onSelect: (folder: string) => void;

  constructor(app: App, folders: string[], onSelect: (folder: string) => void) {
    super(app);
    this.folders = folders;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Select poster folder" });

    const folderList = contentEl.createDiv({ cls: "folder-selection-list" });

    this.folders.forEach((folder) => {
      const folderItem = folderList.createDiv({ cls: "folder-selection-item" });
      folderItem.setText(folder || "(Root folder)");

      folderItem.addEventListener("click", () => {
        this.onSelect(folder);
        this.close();
      });
    });

    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });

    const cancelBtn = buttonContainer.createEl("button");
    cancelBtn.setText("Cancel");
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
  }
}

class JellyfinInstanceModal extends Modal {
  instance: JellyfinInstance;
  onSave: (instance: JellyfinInstance) => void;
  isEdit: boolean;

  constructor(app: App, instance: JellyfinInstance | null, onSave: (instance: JellyfinInstance) => void) {
    super(app);
    this.instance = instance || { name: "", url: "", apiKey: "", userId: "" };
    this.isEdit = instance !== null;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.isEdit ? "Edit Jellyfin instance" : "Add Jellyfin instance" });

    new Setting(contentEl)
      .setName("Name")
      .setDesc("A friendly name for this Jellyfin instance")
      .addText((text) => {
        text
          .setPlaceholder("My Jellyfin server")
          .setValue(this.instance.name)
          .onChange((value) => {
            this.instance.name = value;
          });
      });

    new Setting(contentEl)
      .setName("URL")
      .setDesc("Jellyfin server URL (e.g., http://localhost:8096)")
      .addText((text) => {
        text
          .setPlaceholder("http://localhost:8096")
          .setValue(this.instance.url)
          .onChange((value) => {
            this.instance.url = value;
          });
      });

    new Setting(contentEl)
      .setName("API key")
      .setDesc("Jellyfin API key (generate in Dashboard GåÆ API keys)")
      .addText((text) => {
        text
          .setPlaceholder("API key")
          .setValue(this.instance.apiKey)
          .onChange((value) => {
            this.instance.apiKey = value;
          });
      });

    new Setting(contentEl)
      .setName("User ID")
      .setDesc("Optional, if provided will be used to set watch status")
      .addText((text) => {
        text
          .setPlaceholder("User ID")
          .setValue(this.instance.userId)
          .onChange((value) => {
            this.instance.userId = value;
          });
      });

    const buttonContainer = contentEl.createDiv({ cls: "jellyfin-modal-buttons" });

    const saveBtn = buttonContainer.createEl("button", { cls: "mod-cta" });
    saveBtn.setText("Save");
    saveBtn.addEventListener("click", () => {
      if (!this.instance.name || !this.instance.url || !this.instance.apiKey) {
        new Notice("Please fill in all required fields");
        return;
      }
      this.onSave(this.instance);
      this.close();
    });

    const cancelBtn = buttonContainer.createEl("button");
    cancelBtn.setText("Cancel");
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
  }
}

class PlexConfigModal extends Modal {
  settings: PlexSettings;
  onSave: (settings: PlexSettings) => void;
  pollingCancelled: boolean = false;
  authStatus: "unknown" | "authenticated" | "unauthenticated" = "unknown";
  plexApi: PlexApiService = new PlexApiService();

  constructor(app: App, settings: PlexSettings, onSave: (settings: PlexSettings) => void) {
    super(app);
    this.settings = { ...settings };
    this.onSave = onSave;
  }

  private generateClientIdentifier(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `plex-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private async startAuthFlow(): Promise<void> {
    if (!this.settings.appName || !this.settings.clientIdentifier) {
      new Notice("Please fill in the app name and client identifier first");
      return;
    }

    try {
      const pin = await this.plexApi.createPin(this.settings.appName, this.settings.clientIdentifier);
      const authUrl = this.plexApi.buildAuthUrl({
        clientIdentifier: this.settings.clientIdentifier,
        pinCode: pin.code,
        appName: this.settings.appName,
      });

      console.log('here')
      window.open(authUrl);
      new Notice("Complete Plex sign-in in your browser. Waiting for confirmation...", 8000);

      const token = await this.plexApi.pollForToken({
        pinId: pin.id,
        pinCode: pin.code,
        clientIdentifier: this.settings.clientIdentifier,
        shouldCancel: () => this.pollingCancelled,
      });

      if (!token) {
        new Notice("Plex sign-in not completed.");
        return;
      }

      this.settings.accessToken = token;
      this.onSave(this.settings);
      new Notice("Plex authentication complete.");
      this.authStatus = "authenticated";
      this.onOpen();
    } catch (error: unknown) {
      new Notice("Plex authentication failed. Check console for details.");
      console.error("Plex authentication error:", error);
    }
  }

  private async runConnectionTest(): Promise<void> {
    if (!this.settings.appName || !this.settings.clientIdentifier) {
      new Notice("Please fill in the app name and client identifier first");
      return;
    }

    const isValid = await this.plexApi.validateToken(
      this.settings.appName,
      this.settings.clientIdentifier,
      this.settings.accessToken
    );

    let sectionsOutput = "";
    let itemsOutput = "";
    if (isValid) {
      try {
        const resources = await this.plexApi.getResources(
          this.settings.appName,
          this.settings.clientIdentifier,
          this.settings.accessToken
        );

        const resourceList = Array.isArray(resources) ? resources : [];
        const servers = resourceList.filter((resource) => {
          const provides = resource?.provides;
          return typeof provides === "string" && provides.includes("server");
        });

        const configuredServers = Array.isArray(this.settings.servers) ? this.settings.servers : [];
        const enabledServers = configuredServers.filter((server) => server.enabled);
        const selectedServers = enabledServers.length > 0
          ? servers.filter((server) => {
              const name = server?.name || server?.clientIdentifier || "Unknown server";
              return enabledServers.some((configured) => configured.name === name);
            })
          : servers;

        const targetServer = selectedServers[0];
        const serverUri = targetServer?.connections?.[0]?.uri;

        if (serverUri) {
          const sections = await this.plexApi.getLibrarySections(
            serverUri,
            this.settings.accessToken
          );
          sectionsOutput = typeof sections === "string" ? sections : JSON.stringify(sections, null, 2);

          const sectionKey = sections?.MediaContainer?.Directory?.[0]?.key;
          if (sectionKey) {
            const items = await this.plexApi.getLibraryItems(
              serverUri,
              sectionKey.toString(),
              this.settings.accessToken
            );
            itemsOutput = typeof items === "string" ? items : JSON.stringify(items, null, 2);
          } else {
            itemsOutput = "No library sections available to query.";
          }
        } else {
          sectionsOutput = "No Plex server URI available.";
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        sectionsOutput = `Error fetching library sections: ${message}`;
        itemsOutput = `Error fetching library items: ${message}`;
      }
    }

    const timestamp = new Date().toLocaleString();
    const content = [
      "# Plex Connection Test",
      "",
      `Timestamp: ${timestamp}`,
      `App Name: ${this.settings.appName || "(not set)"}`,
      `Client Identifier: ${this.settings.clientIdentifier || "(not set)"}`,
      `Authenticated: ${isValid ? "Yes" : "No"}`,
      "",
      "## Library Sections",
      sectionsOutput || "(not available)",
      "",
      "## Library Items (first section)",
      itemsOutput || "(not available)",
      "",
      "Notes:",
      "- This test verifies the Plex access token against plex.tv.",
      "- The access token is stored internally and is not shown here.",
      ""
    ].join("\n");

    await this.app.vault.adapter.write("PlexTest.md", content);
    new Notice("Wrote PlexTest.md with connection results.");
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Plex configuration" });

    contentEl.createEl("p", {
      text: "These values identify this plugin to Plex. The app name appears in Plex Authorized Devices, and the client identifier is generated by the plugin for this install.",
      cls: "setting-item-description"
    });

    new Setting(contentEl)
      .setName("App name")
      .setDesc("Shown in Plex Authorized Devices (e.g., Who Is Streaming)")
      .addText((text) => {
        text
          .setPlaceholder("Who Is Streaming")
          .setValue(this.settings.appName)
          .onChange((value) => {
            this.settings.appName = value;
          });
      });

    new Setting(contentEl)
      .setName("Client identifier")
      .setDesc("Unique ID for this plugin install; generated by the plugin")
      .addText((text) => {
        text
          .setPlaceholder("auto-generated")
          .setValue(this.settings.clientIdentifier)
          .onChange((value) => {
            this.settings.clientIdentifier = value;
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Generate")
          .onClick(() => {
            this.settings.clientIdentifier = this.generateClientIdentifier();
            this.onOpen();
          });
      });

    const statusSetting = new Setting(contentEl)
      .setName("Authentication status")
      .setDesc(" ");

    const statusBadge = statusSetting.controlEl.createSpan({ cls: "plex-auth-status" });
    const statusClasses = [
      "plex-auth-status--ok",
      "plex-auth-status--bad",
      "plex-auth-status--pending",
    ];

    const setStatusBadge = (status: "unknown" | "authenticated" | "unauthenticated") => {
      statusClasses.forEach((cls) => statusBadge.removeClass(cls));
      if (status === "authenticated") {
        statusBadge.setText("Authenticated");
        statusBadge.addClass("plex-auth-status--ok");
      } else if (status === "unauthenticated") {
        statusBadge.setText("Not authenticated");
        statusBadge.addClass("plex-auth-status--bad");
      } else {
        statusBadge.setText("Checking...");
        statusBadge.addClass("plex-auth-status--pending");
      }
    };

    setStatusBadge(this.authStatus);

    if (this.authStatus === "unknown") {
      void (async () => {
        const isValid = await this.plexApi.validateToken(
          this.settings.appName,
          this.settings.clientIdentifier,
          this.settings.accessToken
        );
        this.authStatus = isValid ? "authenticated" : "unauthenticated";
        this.onOpen();
      })();
    }

    new Setting(contentEl)
      .setName("Plex connection test")
      .setDesc("Checks Plex connectivity using the stored access token")
      .addButton((button) => {
        button
          .setButtonText("Run test")
          .onClick(() => {
            void this.runConnectionTest();
          });
      });

    const buttonContainer = contentEl.createDiv({ cls: "jellyfin-modal-buttons" });

    if (this.authStatus !== "authenticated") {
      const connectBtn = buttonContainer.createEl("button", { cls: "mod-cta" });
      connectBtn.setText("Connect");
      connectBtn.addEventListener("click", () => {
        void this.startAuthFlow();
      });
    } else {
      const disconnectBtn = buttonContainer.createEl("button", { cls: "mod-warning" });
      disconnectBtn.setText("Disconnect");
      disconnectBtn.addEventListener("click", () => {
        this.settings.accessToken = "";
        this.onSave(this.settings);
        this.authStatus = "unauthenticated";
        this.onOpen();
      });
    }

    const cancelBtn = buttonContainer.createEl("button");
    cancelBtn.setText("Cancel");
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
  }

  onClose() {
    this.pollingCancelled = true;
  }
}

export class WhoIsStreamingSettingsTab extends PluginSettingTab {
  plugin: WhoIsStreamingPlugin;
  countrySetting: Setting;
  streamingServicesElement: HTMLElement;
  plexServersElement: HTMLElement;

  constructor(app: App, plugin: WhoIsStreamingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.streamingServicesElement = createDiv();
    this.plexServersElement = createDiv();
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl).setName("API configuration").setHeading();

    const fragment = new DocumentFragment();
    const descDiv = fragment.createDiv({ cls: "setting-item-description" });
    descDiv.appendText("Sign up for an API key: ");
    descDiv.createEl("a", {
      text: "https://www.movieofthenight.com/about/api",
      href: "https://www.movieofthenight.com/about/api"
    });

    new Setting(containerEl)
      .setName("API key")
      .setDesc(fragment)
      .addText((text) => {
        text.setValue(this.plugin.settings.apiKey).onChange((value) => {
          void (async () => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
            this.plugin.setupApiClient();
            await this.initializeCountries();
          })();
        });
      });

    this.countrySetting = new Setting(containerEl)
      .setName("Country")
      .setDesc("Country to check streaming services for");

    new Setting(containerEl)
      .setName("Rate limit warning threshold")
      .setDesc("Show a warning when API quota usage reaches this percentage (0 to disable)")
      .addSlider((slider) => {
        slider
          .setLimits(0, 100, 5)
          .setValue(this.plugin.settings.rateLimitWarningThreshold)
          .setDynamicTooltip()
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.rateLimitWarningThreshold = value;
              await this.plugin.saveSettings();
            })();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default (80%)")
          .onClick(() => {
            void (async () => {
              this.plugin.settings.rateLimitWarningThreshold = 80;
              await this.plugin.saveSettings();
              this.display();
            })();
          });
      });

    new Setting(containerEl).setName("Note formatting").setHeading();

    new Setting(containerEl)
      .setName("Movie note format")
      .setDesc("Format for movie notes. Available: ${title}, ${year}, ${tmdb_id}, ${rating}, ${runtime}")
      .addText((text) => {
        text
          .setPlaceholder("${title} (${year})")
          .setValue(this.plugin.settings.noteNameFormat)
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.noteNameFormat = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    new Setting(containerEl)
      .setName("TV series note format")
      .setDesc("Format for TV series notes. Available: ${title}, ${firstAirYear}, ${lastAirYear}, ${tmdb_id}, ${rating}")
      .addText((text) => {
        text
          .setPlaceholder("${title} (${firstAirYear}-${lastAirYear})")
          .setValue(this.plugin.settings.noteNameFormatSeries)
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.noteNameFormatSeries = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    new Setting(containerEl).setName("Poster images").setHeading();

    new Setting(containerEl)
      .setName("Poster mode")
      .setDesc("How to handle poster images in notes")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("none", "Don't use posters")
          .addOption("local", "Download posters locally")
          .addOption("remote", "Use remote posters")
          .setValue(this.plugin.settings.posterMode)
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.posterMode = value as "none" | "local" | "remote";
              await this.plugin.saveSettings();
            })();
          });
      });

    new Setting(containerEl)
      .setName("Poster folder")
      .setDesc("Folder path for storing downloaded posters")
      .addText((text) => {
        text
          .setPlaceholder("Posters")
          .setValue(this.plugin.settings.posterFolder)
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.posterFolder = value;
              await this.plugin.saveSettings();
            })();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Browse")
          .onClick(() => {
            const folders = this.app.vault.getAllFolders();
            const folderNames = folders.map(f => f.path).filter(path => path !== "");
            folderNames.unshift("");

            new FolderSelectionModal(
              this.app,
              folderNames,
              (selectedFolder) => {
                void (async () => {
                  this.plugin.settings.posterFolder = selectedFolder;
                  await this.plugin.saveSettings();
                  this.display();
                })();
              }
            ).open();
          });
      });

    new Setting(containerEl).setName("Jellyfin integration").setHeading();

    new Setting(containerEl)
      .setName("Jellyfin instances")
      .setDesc("Add Jellyfin servers to check for movie availability");

    this.plugin.settings.jellyfinInstances.forEach((instance, index) => {
      new Setting(containerEl)
        .setName(instance.name)
        .setDesc(`${instance.url}`)
        .addButton((button) => {
          button
            .setButtonText("Edit")
            .onClick(() => {
              new JellyfinInstanceModal(
                this.app,
                { ...instance },
                (updatedInstance) => {
                  void (async () => {
                    this.plugin.settings.jellyfinInstances[index] = updatedInstance;
                    await this.plugin.saveSettings();
                    this.display();
                  })();
                }
              ).open();
            });
        })
        .addButton((button) => {
          button
            .setButtonText("Remove")
            .setWarning()
            .onClick(() => {
              void (async () => {
                this.plugin.settings.jellyfinInstances.splice(index, 1);
                await this.plugin.saveSettings();
                this.display();
              })();
            });
        });
    });

    new Setting(containerEl)
      .addButton((button) => {
        button
          .setButtonText("Add Jellyfin instance")
          .setCta()
          .onClick(() => {
            new JellyfinInstanceModal(
              this.app,
              null,
              (newInstance) => {
                void (async () => {
                  this.plugin.settings.jellyfinInstances.push(newInstance);
                  await this.plugin.saveSettings();
                  this.display();
                })();
              }
            ).open();
          });
      });

    new Setting(containerEl).setName("Plex integration").setHeading();

    const plexDescription = new DocumentFragment();
    const plexDescEl = plexDescription.createDiv({ cls: "setting-item-description" });
    plexDescEl.appendText("Configure the app name and client identifier for Plex authentication. The client identifier is generated by the plugin and identifies this install.");

    new Setting(containerEl)
      .setName("Plex configuration")
      .setDesc(plexDescription)
      .addButton((button) => {
        button
          .setButtonText("Configure Plex")
          .setCta()
          .onClick(() => {
            new PlexConfigModal(
              this.app,
              this.plugin.settings.plex,
              (updatedSettings) => {
                void (async () => {
                  this.plugin.settings.plex = updatedSettings;
                  await this.plugin.saveSettings();
                  this.display();
                })();
              }
            ).open();
          });
      });

    containerEl.append(this.plexServersElement);
    void this.initializePlexServers();

    if (isPluginEnabled(this.app)) {
      new Setting(containerEl).setName("Bulk sync").setHeading();
      new Setting(containerEl)
        .setName("Dataview query")
        .setDesc("Filter which notes to sync when using 'Sync all shows'")
        .setClass("who-is-streaming-textarea")
        .addTextArea((text) => {
          text
            .setPlaceholder('FROM "Movies"\nWHERE Type = "movie"')
            .setValue(this.plugin.settings.bulkSyncDataviewQuery)
            .onChange((value) => {
              void (async () => {
                this.plugin.settings.bulkSyncDataviewQuery = value;
                await this.plugin.saveSettings();
              })();
            });
        });
    }

    new Setting(containerEl).setName("Sync behavior").setHeading();

    new Setting(containerEl)
      .setName("Show preview dialog")
      .setDesc("Show a preview of changes before syncing")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showPreviewDialog)
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.showPreviewDialog = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    new Setting(containerEl)
      .setName("Add streaming links")
      .setDesc("Add direct links to streaming services")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.addStreamingLinks)
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.addStreamingLinks = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    containerEl.createEl("p", {
      text: "Select which fields should be synced by default in preview and bulk sync operations. Note: Type and tmdb_id are always synced and cannot be disabled.",
      cls: "setting-item-description"
    });

    const fieldDefinitions = [
      { id: "File Name", name: "File Name", desc: "Rename the note based on the configured format" },
      { id: "Poster", name: "Poster", desc: "Poster image" },
      { id: "Year", name: "Year", desc: "Release year or first air year" },
      { id: "Directors", name: "Directors", desc: "Director names" },
      { id: "Cast", name: "Cast", desc: "Cast member names" },
      { id: "Overview", name: "Overview", desc: "Show description/synopsis" },
      { id: "Genres", name: "Genres", desc: "Genre list" },
      { id: "Runtime", name: "Runtime", desc: "Runtime in minutes" },
      { id: "Rating", name: "Rating", desc: "IMDB rating" },
      { id: "Seasons", name: "Seasons", desc: "Number of seasons" },
      { id: "Episodes", name: "Episodes", desc: "Number of episodes" },
    ];

    fieldDefinitions.forEach((field) => {
      new Setting(containerEl)
        .setName(field.name)
        .setDesc(field.desc)
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.defaultEnabledFields.includes(field.id))
            .onChange((value) => {
              void (async () => {
                if (value) {
                  if (!this.plugin.settings.defaultEnabledFields.includes(field.id)) {
                    this.plugin.settings.defaultEnabledFields.push(field.id);
                  }
                } else {
                  const index = this.plugin.settings.defaultEnabledFields.indexOf(field.id);
                  if (index > -1) {
                    this.plugin.settings.defaultEnabledFields.splice(index, 1);
                  }
                }
                await this.plugin.saveSettings();
              })();
            });
        });
    });

    new Setting(containerEl).setName("Movies view display").setHeading();

    new Setting(containerEl)
      .setName("Default grid poster size")
      .setDesc("Poster width in pixels for grid view (height is auto-calculated)")
      .addSlider((slider) => {
        slider
          .setLimits(120, 300, 10)
          .setValue(this.plugin.settings.gridPosterSize)
          .setDynamicTooltip()
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.gridPosterSize = value;
              await this.plugin.saveSettings();
            })();
          });
      });

    containerEl.append(this.streamingServicesElement);

    void this.initializeCountries();
    void this.initializeStreamingServices();
  }

  async initializePlexServers(): Promise<void> {
    this.plexServersElement.empty();

    new Setting(this.plexServersElement)
      .setName("Plex servers")
      .setDesc("Select which Plex servers the plugin can query");

    const plexSettings = this.plugin.settings.plex;
    if (!plexSettings.accessToken || !plexSettings.appName || !plexSettings.clientIdentifier) {
      new Setting(this.plexServersElement)
        .setDesc("Authenticate with Plex to load servers.");
      return;
    }

    try {
      const plexApi = new PlexApiService();
      const resources = await plexApi.getResources(
        plexSettings.appName,
        plexSettings.clientIdentifier,
        plexSettings.accessToken
      );

      let resourceList: unknown = resources;
      if (typeof resourceList === "string") {
        try {
          resourceList = JSON.parse(resourceList);
        } catch {
          resourceList = [];
        }
      }

      const servers = Array.isArray(resourceList)
        ? resourceList.filter((resource) => {
            const provides = resource?.provides;
            return typeof provides === "string" && provides.includes("server");
          })
        : [];

      if (servers.length === 0) {
        new Setting(this.plexServersElement)
          .setDesc("No Plex servers found for this account.");
        return;
      }

      const configuredServers = Array.isArray(plexSettings.servers) ? plexSettings.servers : [];

      const configuredByName = new Map(configuredServers.map((server) => [server.name, server]));
      const updatedServers = servers.map((server) => {
        const name = server?.name || server?.clientIdentifier || "Unknown server";
        const uri = server?.connections?.[0]?.uri || "";
        const accessToken = server?.accessToken || plexSettings.accessToken;
        const existing = configuredByName.get(name);

        return {
          name,
          uri: existing?.uri || uri,
          accessToken: existing?.accessToken || accessToken,
          enabled: existing?.enabled ?? false,
        };
      });

      const hasChanges = updatedServers.length != configuredServers.length
        || updatedServers.some((server) => {
          const existing = configuredByName.get(server.name);
          return !existing
            || existing.uri != server.uri
            || existing.accessToken != server.accessToken
            || existing.enabled != server.enabled;
        });

      plexSettings.servers = updatedServers;
      if (hasChanges) {
        await this.plugin.saveSettings();
      }

      updatedServers.forEach((serverConfig) => {
        new Setting(this.plexServersElement)
          .setName(serverConfig.name)
          .addToggle((toggle) => {
            toggle
              .setValue(serverConfig.enabled)
              .onChange((value) => {
                void (async () => {
                  serverConfig.enabled = value;
                  await this.plugin.saveSettings();
                })();
              });
          });
      });
    } catch (error: unknown) {
      new Notice("Failed to load Plex servers. Please try again.");
      console.error("Plex server discovery failed:", error);
    }
  }

  async initializeCountries(): Promise<void> {
    if (!this.plugin.streamingAvailabilityApi.validateApiKey()) {
      return;
    }

    try {
      const countries = await this.plugin.streamingAvailabilityApi.getCountries();

      if (!countries || Object.keys(countries).length === 0) {
        return;
      }

      const userCountryCode = Intl.DateTimeFormat().resolvedOptions().locale.split("-")[1]?.toLowerCase() || "us";

      const sortedCountries = Object.entries(countries).sort(([lk, lv], [rk, rv]) => {
        if (lv.countryCode === userCountryCode) return -1;
        if (rv.countryCode === userCountryCode) return 1;
        return lv.name.localeCompare(rv.name);
      });

      const sorted: { [key: string]: string } = { "": "" };
      for (const [key, country] of sortedCountries) {
        sorted[country.countryCode] = country.name;
      }

      this.countrySetting.addDropdown((dropdown) => {
        dropdown
          .addOptions(sorted)
          .setValue(this.plugin.settings.country)
          .onChange((value) => {
            void (async () => {
              this.plugin.settings.country = value;
              this.plugin.settings.streamingServicesToSync = {};
              await this.plugin.saveSettings();
              void this.initializeStreamingServices();
            })();
          });
      });
    } catch (error: unknown) {
      // Silently fail if countries cannot be loaded - user can still use plugin with cached data
      console.debug('Failed to load countries:', error);
    }
  }

  async initializeStreamingServices(): Promise<void> {
    if (this.plugin.settings.country?.length < 2) return;

    this.streamingServicesElement.empty();
    new Setting(this.streamingServicesElement).setName("Streaming services").setHeading();

    try {
      const countries = await this.plugin.streamingAvailabilityApi.getCountries();

      if (!countries || Object.keys(countries).length === 0) {
        return;
      }

      if (!countries[this.plugin.settings.country]) {
        new Notice(`GÜán+Å Country "${this.plugin.settings.country}" not available. Please select a different country.`);
        return;
      }

      Object.entries(
        countries[this.plugin.settings.country].services
      ).forEach(([key, service]) => {
        new Setting(this.streamingServicesElement)
          .setName(service.name)
          .addToggle((toggle) => {
            toggle
              .setValue(Object.hasOwn(this.plugin.settings.streamingServicesToSync, key))
              .onChange((value) => {
                void (async () => {
                  if (value)
                    this.plugin.settings.streamingServicesToSync[key] = service;
                  else
                    delete this.plugin.settings.streamingServicesToSync[key];
                  await this.plugin.saveSettings();
                })();
              });
          });
      });

      new Setting(this.streamingServicesElement).setName("Attribution").setHeading();
      const attributionSetting = new Setting(this.streamingServicesElement);
      attributionSetting.descEl.empty();
      attributionSetting.descEl.appendText("This plugin uses ");
      attributionSetting.descEl.createEl("a", {
        text: "Streaming Availability API by Movie of the Night",
        href: "https://www.movieofthenight.com/about/api"
      });
      attributionSetting.descEl.appendText(" but is not affiliated with Movie of the Night.");
    } catch (error: unknown) {
      // Silently fail if streaming services cannot be loaded
      console.debug('Failed to initialize streaming services:', error);
    }
  }
}

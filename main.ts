import {
	App,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	debounce,
	Menu,
	ViewCreator,
	ItemView
} from 'obsidian';

interface HomeSettings {
	pinnedNotes: string[];
	searchPlaceholder: string;
	maxRecentNotes: number;
	maxPinnedNotes: number;
	openHomeOnStartup: boolean;
	replaceNewTabPage: boolean;
	lastOpenedFiles: string[];
}

const DEFAULT_SETTINGS: HomeSettings = {
	pinnedNotes: [],
	searchPlaceholder: '搜索笔记...',
	maxRecentNotes: 10,
	maxPinnedNotes: 10,
	openHomeOnStartup: true,
	replaceNewTabPage: true,
	lastOpenedFiles: []
}

const HOME_VIEW_TYPE = 'home-view';

export default class HomePlugin extends Plugin {
	settings: HomeSettings;

	async onload() {
		console.log('正在加载 Home 插件...');
		await this.loadSettings();

		// 首次加载时，如果最近打开的笔记列表为空，添加一些现有的笔记
		if (this.settings.lastOpenedFiles.length === 0) {
			// 获取最近修改的几个笔记
			const recentFiles = this.app.vault.getMarkdownFiles()
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, this.settings.maxRecentNotes);
			
			// 添加到最近打开列表
			this.settings.lastOpenedFiles = recentFiles.map(file => file.path);
			await this.saveSettings();
		}

		// 注册自定义视图类型
		this.registerView(
			HOME_VIEW_TYPE,
			(leaf) => new HomeView(leaf, this)
		);

		// 添加侧边栏图标
		this.addRibbonIcon('home', '首页', (evt: MouseEvent) => {
			this.openHomeView();
		});

		// 添加命令
		this.addCommand({
			id: 'open-home-view',
			name: '打开首页',
			callback: () => {
				this.openHomeView();
			}
		});

		// 添加置顶笔记的命令
		this.addCommand({
			id: 'pin-current-note',
			name: '置顶当前笔记',
			checkCallback: (checking) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === 'md') {
					if (!checking) {
						this.pinNote(activeFile.path);
					}
					return true;
				}
				return false;
			}
		});

		// 添加取消置顶笔记的命令
		this.addCommand({
			id: 'unpin-current-note',
			name: '取消置顶当前笔记',
			checkCallback: (checking) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension === 'md' && this.isNotePinned(activeFile.path)) {
					if (!checking) {
						this.unpinNote(activeFile.path);
					}
					return true;
				}
				return false;
			}
		});

		// 添加文件菜单项
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && file.extension === 'md') {
					if (this.isNotePinned(file.path)) {
						// 文件已被置顶，显示取消置顶选项
						menu.addItem((item) => {
							item.setTitle('取消置顶')
								.setIcon('pin-off')
								.onClick(() => this.unpinNote(file.path));
						});
					} else {
						// 文件未被置顶，显示置顶选项
						menu.addItem((item) => {
							item.setTitle('置顶到首页')
								.setIcon('pin')
								.onClick(() => this.pinNote(file.path));
						});
					}
				}
			})
		);

		// 监听文件重命名事件，更新置顶笔记和最近文件列表中的路径
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') {
					// 更新置顶笔记列表
					const pinnedIndex = this.settings.pinnedNotes.indexOf(oldPath);
					if (pinnedIndex >= 0) {
						this.settings.pinnedNotes[pinnedIndex] = file.path;
						this.saveSettings();
						this.refreshHomeView('pinned');
					}
					
					// 更新最近文件列表
					const recentIndex = this.settings.lastOpenedFiles.indexOf(oldPath);
					if (recentIndex >= 0) {
						this.settings.lastOpenedFiles[recentIndex] = file.path;
						this.saveSettings();
						this.refreshHomeView('recent');
					}
				}
			})
		);

		// 监听文件删除事件，从置顶列表和最近文件列表中移除已删除的文件
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					let needsUpdate = false;
					
					// 从置顶笔记列表中移除
					if (this.isNotePinned(file.path)) {
						this.settings.pinnedNotes = this.settings.pinnedNotes.filter(path => path !== file.path);
						needsUpdate = true;
					}
					
					// 从最近文件列表中移除
					const recentIndex = this.settings.lastOpenedFiles.indexOf(file.path);
					if (recentIndex >= 0) {
						this.settings.lastOpenedFiles = this.settings.lastOpenedFiles.filter(path => path !== file.path);
						needsUpdate = true;
					}
					
					// 如果有更新，保存设置并刷新视图
					if (needsUpdate) {
						this.saveSettings();
						this.refreshHomeView('both');
					}
				}
			})
		);

		// 添加设置选项卡
		this.addSettingTab(new HomeSettingTab(this.app, this));

		// 监听文件打开事件，更新最近文件列表
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file && file instanceof TFile && file.extension === 'md') {
					this.updateRecentFiles(file.path);
				}
			})
		);

		// 监听应用启动事件
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.openHomeOnStartup) {
				// 应用启动时打开首页
				setTimeout(() => this.openHomeView(), 500);
			}
		});

		// 监听新标签页创建事件
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				// 检查是否有空标签页，如果有且设置了替换新标签页，则打开首页
				if (this.settings.replaceNewTabPage) {
					const emptyLeaves = this.app.workspace.getLeavesOfType('empty');
					if (emptyLeaves.length > 0) {
						const emptyLeaf = emptyLeaves[0];
						setTimeout(() => {
							try {
								// 确保页面是空的，然后替换为首页
								const viewType = emptyLeaf?.view?.getViewType();
								if (viewType === 'empty') {
									emptyLeaf.setViewState({
										type: HOME_VIEW_TYPE,
										active: true
									});
								}
							} catch (error) {
								console.error("处理空白标签页时出错：", error);
							}
						}, 100);
					}
				}
			})
		);

		console.log('Home 插件加载完成');
	}

	async updateRecentFiles(filePath: string) {
		// 从最近文件列表中移除当前文件（如果存在）
		this.settings.lastOpenedFiles = this.settings.lastOpenedFiles.filter(path => path !== filePath);
		
		// 将当前文件添加到列表开头
		this.settings.lastOpenedFiles.unshift(filePath);
		
		// 保持列表不超过设置的最大数量
		if (this.settings.lastOpenedFiles.length > this.settings.maxRecentNotes) {
			this.settings.lastOpenedFiles = this.settings.lastOpenedFiles.slice(0, this.settings.maxRecentNotes);
		}
		
		// 保存设置以持久化最近文件列表
		await this.saveSettings();
		
		// 如果首页视图已打开，更新显示
		this.refreshHomeView('recent');
	}

	async openHomeView() {
		const { workspace } = this.app;
		
		// 检查是否已有首页视图
		const existingHomeLeaves = workspace.getLeavesOfType(HOME_VIEW_TYPE);
		
		if (existingHomeLeaves.length > 0) {
			// 激活已有的首页视图
			workspace.revealLeaf(existingHomeLeaves[0]);
			return;
		}

		try {
			// 创建新的标签页并打开首页视图
			const leaf = workspace.getLeaf('tab');
			await leaf.setViewState({
				type: HOME_VIEW_TYPE,
				active: true
			});
			
			// 确保视图处于激活状态
			workspace.revealLeaf(leaf);
		} catch (error) {
			console.error("打开首页视图时出错：", error);
			new Notice("无法打开首页视图，请查看控制台以获取更多信息");
		}
	}

	onunload() {
		console.log('正在卸载 Home 插件...');
		// 当插件被禁用时，关闭所有首页视图
		this.app.workspace
			.getLeavesOfType(HOME_VIEW_TYPE)
			.forEach(leaf => leaf.detach());
		console.log('Home 插件卸载完成');
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		
		// 迁移旧数据
		if (data && Array.isArray((this as any).lastOpenedFiles) && (this as any).lastOpenedFiles.length > 0) {
			// 如果有旧的 lastOpenedFiles 数组，迁移到新的设置中
			this.settings.lastOpenedFiles = (this as any).lastOpenedFiles;
			await this.saveSettings();
			console.log('已迁移最近打开的笔记记录到新的设置中');
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 检查笔记是否已被置顶
	isNotePinned(filePath: string): boolean {
		return this.settings.pinnedNotes.includes(filePath);
	}

	// 置顶笔记
	async pinNote(filePath: string): Promise<void> {
		// 检查是否已经置顶
		if (this.isNotePinned(filePath)) {
			return;
		}
		
		// 检查是否达到最大置顶数
		if (this.settings.pinnedNotes.length >= this.settings.maxPinnedNotes) {
			new Notice(`置顶笔记数量已达最大值 (${this.settings.maxPinnedNotes})。请先取消一些置顶笔记。`);
			return;
		}
		
		// 添加到置顶列表
		this.settings.pinnedNotes.push(filePath);
		await this.saveSettings();
		new Notice("笔记已置顶到首页");
		
		// 如果首页视图已打开，更新显示
		this.refreshHomeViewIfOpen();
	}

	// 取消置顶笔记
	async unpinNote(filePath: string): Promise<void> {
		// 检查是否已经置顶
		if (!this.isNotePinned(filePath)) {
			return;
		}
		
		// 从置顶列表中移除
		this.settings.pinnedNotes = this.settings.pinnedNotes.filter(path => path !== filePath);
		await this.saveSettings();
		new Notice("已取消笔记的置顶");
		
		// 如果首页视图已打开，更新显示
		this.refreshHomeViewIfOpen();
	}

	// 如果首页视图已打开，刷新内容
	refreshHomeViewIfOpen(): void {
		this.refreshHomeView('pinned');
	}
	
	// 刷新首页视图的特定部分
	refreshHomeView(part: 'pinned' | 'recent' | 'both'): void {
		const homeLeaves = this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE);
		if (homeLeaves.length > 0) {
			const homeView = homeLeaves[0].view as HomeView;
			if (homeView) {
				if (part === 'pinned' || part === 'both') {
					homeView.renderPinnedNotes();
				}
				if (part === 'recent' || part === 'both') {
					homeView.renderRecentNotes();
				}
			}
		}
	}
}

class HomeView extends ItemView {
	plugin: HomePlugin;
	searchInput: HTMLInputElement;
	pinnedContainer: HTMLElement;
	recentContainer: HTMLElement;
	searchResultsContainer: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: HomePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return HOME_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "首页";
	}

	getIcon(): string {
		return "home";
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("home-plugin-view");

		this.renderHomeView();
	}

	renderHomeView() {
		// 创建搜索框
		const searchContainer = this.contentEl.createDiv({ cls: "home-search-container" });
		this.searchInput = searchContainer.createEl("input", {
			type: "text",
			placeholder: this.plugin.settings.searchPlaceholder,
			cls: "home-search-input"
		});
		
		// 搜索结果容器
		this.searchResultsContainer = searchContainer.createDiv({ 
			cls: "home-search-results-container" 
		});

		// 创建两栏布局的容器
		const columnsContainer = this.contentEl.createDiv({ cls: "home-columns-container" });
		
		// 左侧：置顶笔记
		const pinnedColumn = columnsContainer.createDiv({ cls: "home-column home-pinned-column" });
		pinnedColumn.createEl("h2", { text: "置顶笔记" });
		this.pinnedContainer = pinnedColumn.createDiv({ cls: "home-pinned-container" });
		
		// 右侧：最近打开的笔记
		const recentColumn = columnsContainer.createDiv({ cls: "home-column home-recent-column" });
		recentColumn.createEl("h2", { text: "最近打开" });
		this.recentContainer = recentColumn.createDiv({ cls: "home-recent-container" });
		
		// 渲染内容
		this.renderPinnedNotes();
		this.renderRecentNotes();

		// 添加搜索功能
		this.setupSearch();
	}

	setupSearch() {
		// 使用 debounce 减少搜索频率
		const debouncedSearch = debounce(
			(query: string) => this.performSearch(query), 
			250, 
			true
		);

		this.searchInput.addEventListener("input", (e) => {
			const target = e.target as HTMLInputElement;
			const query = target.value.trim();
			
			if (query) {
				debouncedSearch(query);
				this.showSearchResults();
			} else {
				this.hideSearchResults();
				this.searchResultsContainer.empty();
			}
		});

		// 点击外部区域关闭搜索结果
		document.addEventListener("click", (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			const isSearchInput = target.isEqualNode(this.searchInput);
			const isSearchResult = this.searchResultsContainer.contains(target);
			
			if (!isSearchInput && !isSearchResult) {
				this.hideSearchResults();
			}
		});

		// 聚焦搜索框时显示结果（如果有）
		this.searchInput.addEventListener("focus", () => {
			if (this.searchInput.value.trim() && this.searchResultsContainer.children.length > 0) {
				this.showSearchResults();
			}
		});
	}

	// 辅助方法：显示搜索结果
	showSearchResults() {
		this.searchResultsContainer.addClass("is-visible");
	}

	// 辅助方法：隐藏搜索结果
	hideSearchResults() {
		this.searchResultsContainer.removeClass("is-visible");
	}

	async performSearch(query: string) {
		this.searchResultsContainer.empty();
		
		if (!query) return;
		
		// 使用 Obsidian 的搜索 API
		const searchResults: TFile[] = [];
		
		// 从 vault 中搜索匹配的文件
		const markdownFiles = this.app.vault.getMarkdownFiles();
		for (const file of markdownFiles) {
			// 简单的文件名搜索，可以根据需要扩展更复杂的搜索
			if (file.basename.toLowerCase().contains(query.toLowerCase())) {
				searchResults.push(file);
			}
		}
		
		if (searchResults.length === 0) {
			this.searchResultsContainer.createEl("p", { 
				text: "未找到匹配的笔记", 
				cls: "home-no-results" 
			});
			return;
		}

		const resultsList = this.searchResultsContainer.createEl("ul", { cls: "home-search-results" });
		
		// 限制最多显示 20 条结果
		const limitedResults = searchResults.slice(0, 20);
		
		for (const file of limitedResults) {
			const item = resultsList.createEl("li", { cls: "home-search-result-item" });
			
			const link = item.createEl("a", { 
				cls: "home-note-link", 
				text: file.basename 
			});
			
			// 使用事件委托，确保整个列表项都可点击
			item.addEventListener("click", async (e) => {
				e.preventDefault();
				await this.app.workspace.getLeaf().openFile(file);
				this.hideSearchResults();
				this.searchInput.value = "";
			});
		}
	}

	renderPinnedNotes() {
		this.pinnedContainer.empty();
		
		if (this.plugin.settings.pinnedNotes.length === 0) {
			this.pinnedContainer.createEl("p", { 
				text: "没有置顶笔记，请在设置中添加", 
				cls: "home-empty-message" 
			});
			return;
		}
		
		const pinnedList = this.pinnedContainer.createEl("ul", { cls: "home-pinned-list" });
		
		for (const path of this.plugin.settings.pinnedNotes) {
			const file = this.app.vault.getAbstractFileByPath(path);
			
			if (file instanceof TFile) {
				const item = pinnedList.createEl("li", { cls: "home-pinned-item" });
				
				const link = item.createEl("a", { 
					cls: "home-note-link", 
					text: file.basename 
				});
				
				link.addEventListener("click", async () => {
					await this.app.workspace.getLeaf().openFile(file);
				});
			}
		}
	}

	renderRecentNotes() {
		this.recentContainer.empty();
		
		// 过滤掉不存在的文件路径
		const validPaths: string[] = [];
		let hasRemovedPaths = false;
		
		for (const path of this.plugin.settings.lastOpenedFiles) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				validPaths.push(path);
			} else {
				hasRemovedPaths = true;
			}
		}
		
		// 如果有无效文件路径，更新设置
		if (hasRemovedPaths) {
			this.plugin.settings.lastOpenedFiles = validPaths;
			this.plugin.saveSettings();
		}
		
		if (validPaths.length === 0) {
			this.recentContainer.createEl("p", { 
				text: "没有最近打开的笔记", 
				cls: "home-empty-message" 
			});
			return;
		}
		
		const recentList = this.recentContainer.createEl("ul", { cls: "home-recent-list" });
		
		for (const path of validPaths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			
			if (file instanceof TFile) {
				const item = recentList.createEl("li", { cls: "home-recent-item" });
				
				const link = item.createEl("a", { 
					cls: "home-note-link", 
					text: file.basename 
				});
				
				link.addEventListener("click", async () => {
					await this.app.workspace.getLeaf().openFile(file);
				});
			}
		}
	}
}

class HomeSettingTab extends PluginSettingTab {
	plugin: HomePlugin;

	constructor(app: App, plugin: HomePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h4", { text: "首页插件设置" });

		new Setting(containerEl)
			.setName("启动时打开首页")
			.setDesc("在 Obsidian 启动时自动打开首页")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.openHomeOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.openHomeOnStartup = value;
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl)
			.setName("替换新标签页")
			.setDesc("当创建新标签页时，自动显示首页内容")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.replaceNewTabPage)
				.onChange(async (value) => {
					this.plugin.settings.replaceNewTabPage = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("搜索占位符")
			.setDesc("设置搜索框中显示的占位文本")
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.searchPlaceholder)
				.setValue(this.plugin.settings.searchPlaceholder)
				.onChange(async (value) => {
					this.plugin.settings.searchPlaceholder = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName("最大最近笔记数")
			.setDesc("设置在最近打开列表中显示的最大笔记数量")
			.addSlider(slider => slider
				.setLimits(0, 30, 1)
				.setValue(this.plugin.settings.maxRecentNotes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxRecentNotes = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName("最大置顶笔记数")
			.setDesc("设置可以置顶的最大笔记数量")
			.addSlider(slider => slider
				.setLimits(0, 30, 1)
				.setValue(this.plugin.settings.maxPinnedNotes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxPinnedNotes = value;
					await this.plugin.saveSettings();
				}));
		
		containerEl.createEl("h4", { text: "置顶笔记管理" });
		
		this.renderPinnedNotesList(containerEl);

		new Setting(containerEl)
			.setName("添加置顶笔记")
			.setDesc("选择要添加到置顶列表的笔记")
			.addButton(button => button
				.setButtonText("选择笔记")
				.onClick((evt: MouseEvent) => this.openFileSelectorModal(evt)));
	}

	renderPinnedNotesList(containerEl: HTMLElement) {
		const pinnedList = containerEl.createEl("div", { cls: "home-setting-pinned-list" });
		
		if (this.plugin.settings.pinnedNotes.length === 0) {
			pinnedList.createEl("p", { text: "没有置顶笔记" });
			return;
		}

		// 显示拖拽提示
		const dragHint = pinnedList.createEl("p", { 
			cls: "setting-item-description", 
			text: "提示：可以拖拽笔记项目调整顺序" 
		});
		dragHint.style.marginBottom = "10px";
		
		// 创建拖拽容器
		const dragContainer = pinnedList.createEl("div", { cls: "home-setting-pinned-items" });
		
		// 为每个置顶笔记创建一个可拖拽的项目
		this.plugin.settings.pinnedNotes.forEach((path, index) => {
			const file = this.app.vault.getAbstractFileByPath(path);
			const name = file instanceof TFile ? file.basename : path;
			
			// 创建一个可拖拽的容器
			const itemContainer = dragContainer.createEl("div", { 
				cls: "home-setting-pinned-item",
				attr: {
					"data-path": path,
					"data-index": index.toString(),
					"draggable": "true",
				}
			});
			
			// 创建设置项
			const settingItem = new Setting(itemContainer)
				.setName(name);
				
			// 添加拖拽手柄
			const dragHandleEl = document.createElement('span');
			dragHandleEl.className = 'home-drag-handle';
			dragHandleEl.innerHTML = '⠿⠿'; // 垂直点作为拖拽图标
			dragHandleEl.ariaLabel = '拖拽调整顺序';
			settingItem.nameEl.prepend(dragHandleEl);
			
			// 添加操作按钮
			settingItem
				.addExtraButton(button => button
					.setIcon("trash")
					.setTooltip("移除")
					.onClick(async () => {
						this.plugin.settings.pinnedNotes = this.plugin.settings.pinnedNotes.filter(
							p => p !== path
						);
						await this.plugin.saveSettings();
						this.display();
						this.plugin.refreshHomeView('pinned');
					}));
			
			// 如果文件存在，添加打开文件按钮
			if (file instanceof TFile) {
				settingItem.addExtraButton(button => button
					.setIcon("file")
					.setTooltip("打开笔记")
					.onClick(() => {
						this.app.workspace.getLeaf().openFile(file);
					}));
			}
			
			// 添加拖拽事件处理
			itemContainer.addEventListener("dragstart", (evt: DragEvent) => {
				evt.dataTransfer?.setData("text/plain", path);
				itemContainer.addClass("is-dragging");
			});
			
			itemContainer.addEventListener("dragend", () => {
				itemContainer.removeClass("is-dragging");
				// 移除所有项目的 drag-over 类
				dragContainer.querySelectorAll(".drag-over").forEach(el => {
					el.removeClass("drag-over");
				});
			});
			
			itemContainer.addEventListener("dragover", (evt: DragEvent) => {
				evt.preventDefault();
				itemContainer.addClass("drag-over");
			});
			
			itemContainer.addEventListener("dragleave", () => {
				itemContainer.removeClass("drag-over");
			});
			
			itemContainer.addEventListener("drop", async (evt: DragEvent) => {
				evt.preventDefault();
				itemContainer.removeClass("drag-over");
				
				const sourcePath = evt.dataTransfer?.getData("text/plain");
				if (!sourcePath || sourcePath === path) return;
				
				// 获取源索引和目标索引
				const sourceIndex = this.plugin.settings.pinnedNotes.indexOf(sourcePath);
				const targetIndex = this.plugin.settings.pinnedNotes.indexOf(path);
				
				if (sourceIndex === -1 || targetIndex === -1) return;
				
				// 调整顺序
				const [movedItem] = this.plugin.settings.pinnedNotes.splice(sourceIndex, 1);
				this.plugin.settings.pinnedNotes.splice(targetIndex, 0, movedItem);
				
				// 保存设置并刷新 UI
				await this.plugin.saveSettings();
				this.display();
				this.plugin.refreshHomeView('pinned');
			});
		});
	}

	async openFileSelectorModal(evt: MouseEvent) {
		const { vault } = this.app;
		const mdFiles = vault.getMarkdownFiles();
		
		// 检查是否已达到最大置顶数量
		if (this.plugin.settings.pinnedNotes.length >= this.plugin.settings.maxPinnedNotes) {
			new Notice(`置顶笔记数量已达最大值 (${this.plugin.settings.maxPinnedNotes})。请先移除一些置顶笔记。`);
			return;
		}
		
		// 过滤已经在置顶列表中的文件
		const availableFiles = mdFiles.filter(
			file => !this.plugin.settings.pinnedNotes.includes(file.path)
		);
		
		// 创建菜单来选择文件
		const menu = new Menu();
		
		// 按文件名称排序
		availableFiles.sort((a, b) => a.basename.localeCompare(b.basename));
		
		availableFiles.forEach(file => {
			menu.addItem(item => {
				item
					.setTitle(file.basename)
					.onClick(async () => {
						this.plugin.settings.pinnedNotes.push(file.path);
						await this.plugin.saveSettings();
						this.display();
						this.plugin.refreshHomeView('pinned');
					});
			});
		});
		
		// 显示在点击位置附近
		menu.showAtMouseEvent(evt);
	}
}

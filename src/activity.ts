import { type Selection, type TextDocument, debug, DiagnosticSeverity, env, languages, workspace } from "vscode";
import { resolveLangName, toLower, toTitle, toUpper } from "./helpers/resolveLangName";
import { type GatewayActivityButton } from "discord-api-types/v10";
import { type SetActivity } from "@xhayper/discord-rpc";
import { CONFIG_KEYS, FAKE_EMPTY } from "./constants";
import { getFileSize } from "./helpers/getFileSize";
import { isExcluded } from "./helpers/isExcluded";
import { isObject } from "./helpers/isObject";
import { getConfig } from "./config";
import { dataClass } from "./data";
import { sep } from "node:path";
import { logInfo } from "./logger";

export enum CURRENT_STATUS {
    IDLE = "idle",
    NOT_IN_FILE = "notInFile",
    EDITING = "editing",
    DEBUGGING = "debugging",
    VIEWING = "viewing"
}

export enum PROBLEM_LEVEL {
    ERROR = "error",
    WARNING = "warning",
    INFO = "info",
    HINT = "hint"
}

// TODO: move this to data class
const COUNTED_SEVERITIES: { [key in PROBLEM_LEVEL]: number } = {
    error: 0,
    warning: 0,
    info: 0,
    hint: 0
};

export const onDiagnosticsChange = () => {
    const diagnostics = languages.getDiagnostics();

    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    let hintCount = 0;

    for (const diagnostic of diagnostics.values())
        for (const diagnosticItem of diagnostic[1]) {
            switch (diagnosticItem.severity) {
                case DiagnosticSeverity.Error: {
                    errorCount++;
                    break;
                }
                case DiagnosticSeverity.Warning: {
                    warningCount++;
                    break;
                }
                case DiagnosticSeverity.Information: {
                    infoCount++;
                    break;
                }
                case DiagnosticSeverity.Hint: {
                    hintCount++;
                    break;
                }
            }
        }

    COUNTED_SEVERITIES.error = errorCount;
    COUNTED_SEVERITIES.warning = warningCount;
    COUNTED_SEVERITIES.info = infoCount;
    COUNTED_SEVERITIES.hint = hintCount;
};

export const activity = async (
    previous: SetActivity = {},
    isViewing = false,
    isIdling = false
): Promise<SetActivity> => {
    const config = getConfig();
    const presence = previous;

    if (isIdling && !config.get(CONFIG_KEYS.Status.Idle.Enabled)) return {};

    if (config.get(CONFIG_KEYS.Status.ShowElapsedTime)) {
        presence.startTimestamp = config.get(CONFIG_KEYS.Status.ResetElapsedTimePerFile)
            ? Date.now()
            : previous.startTimestamp ?? Date.now();
    } else {
        delete presence.startTimestamp;
    }

    const detailsEnabled = config.get(CONFIG_KEYS.Status.Details.Enabled);
    const detailsIdleEnabled = config.get(CONFIG_KEYS.Status.Details.Idle.Enabled);
    const stateEnabled = config.get(CONFIG_KEYS.Status.State.Enabled);
    const stateIdleEnabled = config.get(CONFIG_KEYS.Status.State.Idle.Enabled);

    const gitRepo = dataClass.gitRemoteUrl?.toString("https").replace(/\.git$/, "");
    const gitOrg = dataClass.gitRemoteUrl?.organization ?? dataClass.gitRemoteUrl?.owner;
    const gitHost = dataClass.gitRemoteUrl?.source;

    const isRepositoryExcluded = !!gitRepo && isExcluded(config.get(CONFIG_KEYS.Ignore.Repositories)!, gitRepo);
    const isOrganizationExcluded = !!gitOrg && isExcluded(config.get(CONFIG_KEYS.Ignore.Organizations)!, gitOrg);
    const isGitHostExcluded = !!gitHost && isExcluded(config.get(CONFIG_KEYS.Ignore.GitHosts)!, gitHost);
    const isGitExcluded = isRepositoryExcluded || isOrganizationExcluded || isGitHostExcluded;

    let isWorkspaceExcluded =
        dataClass.workspaceFolder !== undefined &&
        isExcluded(config.get(CONFIG_KEYS.Ignore.Workspaces)!, dataClass.workspaceFolder.uri.fsPath);

    if (!isWorkspaceExcluded)
        isWorkspaceExcluded =
            dataClass.workspaceName !== undefined &&
            isExcluded(config.get(CONFIG_KEYS.Ignore.Workspaces)!, dataClass.workspaceName);

    const isNotInFile = !isWorkspaceExcluded && !dataClass.editor;

    const isDebugging = !!debug.activeDebugSession;
    isViewing = !isDebugging && isViewing;

    let status: CURRENT_STATUS;
    if (isIdling) status = CURRENT_STATUS.IDLE;
    else if (isNotInFile) status = CURRENT_STATUS.NOT_IN_FILE;
    else if (isDebugging) status = CURRENT_STATUS.DEBUGGING;
    else if (isViewing) status = CURRENT_STATUS.VIEWING;
    else status = CURRENT_STATUS.EDITING;

    const PROBLEMS = config.get(CONFIG_KEYS.Status.Problems.Enabled)
        ? await replaceFileInfo(
              replaceGitInfo(replaceAppInfo(config.get(CONFIG_KEYS.Status.Problems.Text)!), isGitExcluded),
              isWorkspaceExcluded,
              dataClass.editor?.document,
              dataClass.editor?.selection
          )
        : FAKE_EMPTY;

    const replaceAllText = async (text: string) =>
        (
            await replaceFileInfo(
                replaceGitInfo(replaceAppInfo(text), isGitExcluded),
                isWorkspaceExcluded,
                dataClass.editor?.document,
                dataClass.editor?.selection
            )
        ).replaceAll("{problems}", PROBLEMS);

    let workspaceExcludedText = "No workspace ignore text provided.";
    const ignoreWorkspacesText = config.get(CONFIG_KEYS.Ignore.WorkspacesText)!;

    if (isObject(ignoreWorkspacesText)) {
        workspaceExcludedText =
            (dataClass.workspaceFolder
                ? await replaceAllText(ignoreWorkspacesText[dataClass.workspaceFolder.name])
                : undefined) ?? workspaceExcludedText;
    } else {
        const text = await replaceAllText(ignoreWorkspacesText);
        workspaceExcludedText = text !== "" ? text : undefined ?? workspaceExcludedText;
    }

    let details = isWorkspaceExcluded ? workspaceExcludedText : undefined;
    let state = undefined;

    let largeImageKey = undefined;
    let largeImageText = undefined;

    let smallImageKey = undefined;
    let smallImageText = undefined;

    switch (status) {
        case CURRENT_STATUS.IDLE: {
            if (!isWorkspaceExcluded) {
                if (detailsIdleEnabled && detailsEnabled)
                    details = await replaceAllText(config.get(CONFIG_KEYS.Status.Details.Text.Idle)!);
                if (stateIdleEnabled && stateEnabled)
                    state = await replaceAllText(config.get(CONFIG_KEYS.Status.State.Text.Idle)!);
            }

            largeImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Idle.Key)!);
            largeImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Idle.Text)!);

            smallImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Idle.Key)!);
            smallImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Idle.Text)!);
            break;
        }
        case CURRENT_STATUS.EDITING: {
            if (!isWorkspaceExcluded) {
                if (detailsEnabled)
                    details = await replaceAllText(config.get(CONFIG_KEYS.Status.Details.Text.Editing)!);
                if (stateEnabled) state = await replaceAllText(config.get(CONFIG_KEYS.Status.State.Text.Editing)!);
            }

            largeImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Editing.Key)!);
            largeImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Editing.Text)!);

            smallImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Editing.Key)!);
            smallImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Editing.Text)!);
            break;
        }
        case CURRENT_STATUS.DEBUGGING: {
            if (!isWorkspaceExcluded) {
                if (detailsEnabled)
                    details = await replaceAllText(config.get(CONFIG_KEYS.Status.Details.Text.Debugging)!);
                if (stateEnabled) state = await replaceAllText(config.get(CONFIG_KEYS.Status.State.Text.Debugging)!);
            }

            largeImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Debugging.Key)!);
            largeImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Debugging.Text)!);

            smallImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Debugging.Key)!);
            smallImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Debugging.Text)!);
            break;
        }
        case CURRENT_STATUS.VIEWING: {
            if (!isWorkspaceExcluded) {
                if (detailsEnabled)
                    details = await replaceAllText(config.get(CONFIG_KEYS.Status.Details.Text.Viewing)!);
                if (stateEnabled) state = await replaceAllText(config.get(CONFIG_KEYS.Status.State.Text.Viewing)!);
            }

            largeImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Viewing.Key)!);
            largeImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.Viewing.Text)!);

            smallImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Viewing.Key)!);
            smallImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.Viewing.Text)!);
            break;
        }
        case CURRENT_STATUS.NOT_IN_FILE: {
            if (detailsEnabled) details = await replaceAllText(config.get(CONFIG_KEYS.Status.Details.Text.NotInFile)!);
            if (stateEnabled) state = await replaceAllText(config.get(CONFIG_KEYS.Status.State.Text.NotInFile)!);

            largeImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.NotInFile.Key)!);
            largeImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Large.NotInFile.Text)!);

            smallImageKey = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.NotInFile.Key)!);
            smallImageText = await replaceAllText(config.get(CONFIG_KEYS.Status.Image.Small.NotInFile.Text)!);
            break;
        }
    }
    let buttons = await getPresenceButtons(isIdling, isGitExcluded, status, replaceAllText);
    //
    presence.details = details;
    presence.state = state;
    presence.largeImageKey = largeImageKey;
    presence.largeImageText = largeImageText;
    presence.smallImageKey = smallImageKey;
    presence.smallImageText = smallImageText;
    presence.buttons = buttons;

    // Clean up
    if (!presence.details || presence.details.trim() === "") delete presence.details;
    if (!presence.state || presence.state.trim() === "") delete presence.state;
    if (!presence.largeImageKey || presence.largeImageKey.trim() === "") delete presence.largeImageKey;
    if (!presence.largeImageText || presence.largeImageText.trim() === "") delete presence.largeImageText;
    if (!presence.smallImageKey || presence.smallImageKey.trim() === "") delete presence.smallImageKey;
    if (!presence.smallImageText || presence.smallImageText.trim() === "") delete presence.smallImageText;
    if (!presence.buttons || presence.buttons.length === 0) delete presence.buttons;

    return presence;
};

export const getPresenceButtons = async (
    isIdling: boolean,
    isGitExcluded: boolean,
    status: CURRENT_STATUS,
    replaceAllText: (text: string) => Promise<string>
): Promise<GatewayActivityButton[]> => {
    const config = getConfig();
    let button1Enabled = config.get(CONFIG_KEYS.Status.Buttons.Button1.Enabled)!;
    let button2Enabled = config.get(CONFIG_KEYS.Status.Buttons.Button2.Enabled)!;

    let tempPresenceButton = [];
    if (button1Enabled || button2Enabled) {
        if (isIdling) {
            if (
                config.get(CONFIG_KEYS.Status.Buttons.Button1.Idle.Enabled) ||
                config.get(CONFIG_KEYS.Status.Buttons.Button2.Idle.Enabled)
            ) {
                let button1GitIdleEnabled = config.get(CONFIG_KEYS.Status.Buttons.Button1.Idle.Enabled)! as boolean;
                let button2GitIdleEnabled = config.get(CONFIG_KEYS.Status.Buttons.Button2.Idle.Enabled)! as boolean;
                let gitIdleButton1 = button1GitIdleEnabled && dataClass.gitRemoteUrl && !isGitExcluded;
                let gitIdleButton2 = button2GitIdleEnabled && dataClass.gitRemoteUrl && !isGitExcluded;
                if (config.get(CONFIG_KEYS.Status.Buttons.Button1.Idle.Enabled) && button1Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(
                            gitIdleButton1
                                ? config.get(CONFIG_KEYS.Status.Buttons.Button1.Git.Idle.Label)!
                                : config.get(CONFIG_KEYS.Status.Buttons.Button1.Idle.Label)!
                        ),
                        url: await replaceAllText(
                            gitIdleButton1
                                ? config.get(CONFIG_KEYS.Status.Buttons.Button1.Git.Idle.Url)!
                                : config.get(CONFIG_KEYS.Status.Buttons.Button1.Idle.Url)!
                        )
                    });
                if (config.get(CONFIG_KEYS.Status.Buttons.Button2.Idle.Enabled) && button2Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(
                            gitIdleButton2
                                ? config.get(CONFIG_KEYS.Status.Buttons.Button2.Git.Idle.Label)!
                                : config.get(CONFIG_KEYS.Status.Buttons.Button2.Idle.Label)!
                        ),
                        url: await replaceAllText(
                            gitIdleButton2
                                ? config.get(CONFIG_KEYS.Status.Buttons.Button2.Git.Idle.Url)!
                                : config.get(CONFIG_KEYS.Status.Buttons.Button2.Idle.Url)!
                        )
                    });
            }
        } else if (!isGitExcluded && dataClass.gitRemoteUrl) {
            if (
                config.get(CONFIG_KEYS.Status.Buttons.Button1.Git.Active.Enabled) ||
                config.get(CONFIG_KEYS.Status.Buttons.Button2.Git.Active.Enabled)
            ) {
                if (config.get(CONFIG_KEYS.Status.Buttons.Button1.Git.Active.Enabled) && button1Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button1.Git.Active.Label)!),
                        url: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button1.Git.Active.Url)!)
                    });
                if (config.get(CONFIG_KEYS.Status.Buttons.Button2.Git.Active.Enabled) && button2Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button2.Git.Active.Label)!),
                        url: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button2.Git.Active.Url)!)
                    });
            }
        } else if (isGitExcluded) {
            if (
                config.get(CONFIG_KEYS.Status.Buttons.Button1.Inactive.Enabled) ||
                config.get(CONFIG_KEYS.Status.Buttons.Button2.Inactive.Enabled)
            ) {
                if (config.get(CONFIG_KEYS.Status.Buttons.Button1.Inactive.Enabled) && button1Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button1.Inactive.Label)!),
                        url: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button1.Inactive.Url)!)
                    });
                if (config.get(CONFIG_KEYS.Status.Buttons.Button2.Inactive.Enabled) && button2Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button2.Inactive.Label)!),
                        url: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button2.Inactive.Url)!)
                    });
            }
        } else if (
            status == CURRENT_STATUS.EDITING ||
            status == CURRENT_STATUS.VIEWING ||
            status == CURRENT_STATUS.NOT_IN_FILE
        ) {
            if (
                config.get(CONFIG_KEYS.Status.Buttons.Button1.Active.Enabled) ||
                config.get(CONFIG_KEYS.Status.Buttons.Button2.Active.Enabled)
            ) {
                if (config.get(CONFIG_KEYS.Status.Buttons.Button1.Active.Enabled) && button1Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button1.Active.Label)!),
                        url: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button1.Active.Url)!)
                    });
                if (config.get(CONFIG_KEYS.Status.Buttons.Button2.Active.Enabled) && button2Enabled)
                    tempPresenceButton.push({
                        label: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button2.Active.Label)!),
                        url: await replaceAllText(config.get(CONFIG_KEYS.Status.Buttons.Button2.Active.Url)!)
                    });
            }
        }
    }
    return tempPresenceButton;
};

export const replaceAppInfo = (text: string): string => {
    text = text.slice();
    const { appName } = env;

    const isInsider = appName.includes("Insiders");
    const isCodium = appName.startsWith("VSCodium") || appName.startsWith("codium");

    const insiderAppName = isCodium ? "vscodium-insiders" : "vscode-insiders";
    const normalAppName = isCodium ? "vscodium" : "vscode";

    const replaceMap = new Map([
        ["{app_name}", appName],
        ["{app_id}", isInsider ? insiderAppName : normalAppName]
    ]);

    for (const [key, value] of replaceMap) text = text.replaceAll(key, value);

    return text;
};

export const getTotalProblems = (countedSeverities: PROBLEM_LEVEL[]): number => {
    let totalProblems = 0;

    for (const severity of countedSeverities) {
        switch (severity) {
            case PROBLEM_LEVEL.ERROR: {
                totalProblems += COUNTED_SEVERITIES.error;
                break;
            }
            case PROBLEM_LEVEL.WARNING: {
                totalProblems += COUNTED_SEVERITIES.warning;
                break;
            }
            case PROBLEM_LEVEL.INFO: {
                totalProblems += COUNTED_SEVERITIES.info;
                break;
            }
            case PROBLEM_LEVEL.HINT: {
                totalProblems += COUNTED_SEVERITIES.hint;
                break;
            }
        }
    }

    return totalProblems;
};

export const replaceGitInfo = (text: string, excluded = false): string => {
    text = text.slice();

    const replaceMap = new Map([
        ["{git_owner}", (!excluded ? dataClass.gitRemoteUrl?.owner : undefined) ?? FAKE_EMPTY],
        ["{git_provider}", (!excluded ? dataClass.gitRemoteUrl?.source : undefined) ?? FAKE_EMPTY],
        ["{git_repo}", (!excluded ? dataClass.gitRemoteUrl?.name ?? dataClass.gitRepoName : undefined) ?? FAKE_EMPTY],
        ["{git_branch}", (!excluded ? dataClass.gitBranchName : undefined) ?? FAKE_EMPTY],
        [
            "{git_url}",
            (!excluded ? (dataClass.gitRemoteUrl?.toString("https") ?? "").replace(/\.git$/, "") : undefined) ??
                FAKE_EMPTY
        ]
    ]);

    for (const [key, value] of replaceMap) text = text.replaceAll(key, value);

    return text;
};

export const replaceFileInfo = async (
    text: string,
    excluded = false,
    document?: TextDocument,
    selection?: Selection
): Promise<string> => {
    const config = getConfig();
    text = text.slice();

    let workspaceFolderName =
        dataClass.workspaceFolder?.name ?? config.get(CONFIG_KEYS.Status.Details.Text.NoWorkspaceText)!;
    let workspaceName = dataClass.workspaceName ?? config.get(CONFIG_KEYS.Status.Details.Text.NoWorkspaceText)!;
    let workspaceAndFolder =
        workspaceName + (workspaceFolderName != FAKE_EMPTY ? ` - ${workspaceFolderName}` : FAKE_EMPTY);

    workspaceAndFolder =
        workspaceAndFolder.trim() === ""
            ? config.get(CONFIG_KEYS.Status.Details.Text.NoWorkspaceText)!
            : workspaceAndFolder;

    let fullDirectoryName: string = FAKE_EMPTY;
    const fileIcon = dataClass.editor ? resolveLangName(dataClass.editor.document) : "text";
    const fileSize = await getFileSize(config, dataClass);

    if (dataClass.editor && dataClass.workspaceName && !excluded) {
        const name = dataClass.workspaceName;
        const relativePath = workspace.asRelativePath(dataClass.editor.document.fileName).split(sep);

        relativePath.splice(-1, 1);
        fullDirectoryName = `${name}${sep}${relativePath.join(sep)}`;
    }

    if (excluded) {
        workspaceFolderName = FAKE_EMPTY;
        workspaceName = FAKE_EMPTY;
        workspaceAndFolder = FAKE_EMPTY;
        fullDirectoryName = FAKE_EMPTY;
    }

    const replaceMap = new Map([
        ["{file_name}", dataClass.fileName ?? FAKE_EMPTY],
        ["{file_extension}", dataClass.fileExtension ?? FAKE_EMPTY],
        ["{file_size}", fileSize?.toLocaleString() ?? FAKE_EMPTY],
        ["{folder_and_file}", dataClass.folderAndFile ?? FAKE_EMPTY],
        ["{directory_name}", dataClass.dirName ?? FAKE_EMPTY],
        ["{full_directory_name}", fullDirectoryName],
        ["{workspace}", workspaceName],
        ["{workspace_folder}", workspaceFolderName],
        ["{workspace_and_folder}", workspaceAndFolder],
        ["{lang}", toLower(fileIcon)],
        ["{Lang}", toTitle(fileIcon)],
        ["{LANG}", toUpper(fileIcon)],
        [
            "{problems_count}",
            config.get(CONFIG_KEYS.Status.Problems.Enabled)
                ? getTotalProblems(config.get(CONFIG_KEYS.Status.Problems.countedSeverities)!).toLocaleString()
                : FAKE_EMPTY
        ],
        ["{problems_count_errors}", COUNTED_SEVERITIES.error.toLocaleString()],
        ["{problems_count_warnings}", COUNTED_SEVERITIES.warning.toLocaleString()],
        ["{problems_count_infos}", COUNTED_SEVERITIES.info.toLocaleString()],
        ["{problems_count_hints}", COUNTED_SEVERITIES.hint.toLocaleString()],
        ["{line_count}", document?.lineCount.toLocaleString() ?? FAKE_EMPTY],
        ["{current_line}", selection ? (selection.active.line + 1).toLocaleString() : FAKE_EMPTY],
        ["{current_column}", selection ? (selection.active.character + 1).toLocaleString() : FAKE_EMPTY]
    ]);

    for (const [key, value] of replaceMap) text = text.replaceAll(key, value);

    return text;
};

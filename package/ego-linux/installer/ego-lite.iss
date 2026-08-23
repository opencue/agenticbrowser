; Windows installer for the ego-browser port.
;
; Built on windows-latest by the build-windows-installer CI job, which stages
; the payload first (installer/stage.mjs) and passes the version in:
;
;     iscc /DAppVersion=0.1.0 installer\ego-lite.iss
;
; Everything it ships comes from installer\payload\, so the file list here is
; deliberately one line -- what goes into the install is stage.mjs's decision,
; checked against this script by test/installer.test.mjs.

#define AppName "ego lite"
#define AppExeName "ego-browser.cmd"
#define IconPath "package\ego-linux\assets\ego-lite.ico"

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

[Setup]
; Never change this GUID: Windows identifies the installed product by it, and a
; new one turns every upgrade into a second copy sitting beside the first.
AppId={{A69F19E2-57DD-498D-820E-7E481F9F3380}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=ego lite port contributors
AppSupportURL=https://github.com/NagyVikt/ego-lite-linux
DefaultDirName={localappdata}\Programs\ego-lite
DisableProgramGroupPage=yes
; A per-user install into %LOCALAPPDATA% needs no administrator, which means no
; UAC prompt and a PATH entry we can write under HKCU. Installing for all users
; would buy nothing here -- the profile and the logins in it are per-user
; anyway.
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=ego-lite-setup
SetupIconFile=..\assets\ego-lite.ico
UninstallDisplayIcon={app}\{#IconPath}
Compression=lzma2/max
SolidCompression=yes
; The bundled runtime is node-win-x64; x64compatible also covers ARM64 Windows,
; which runs it under emulation.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Makes Setup broadcast WM_SETTINGCHANGE, so a shell started after this picks
; up the new PATH without a sign-out.
ChangesEnvironment=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; --open is what the Linux desktop entry runs: it brings up the shared agent
; browser window, which is what clicking an app icon should do.
;
; runminimized, not hidden: the target is a console command that returns within
; seconds. Minimized keeps it off the user's screen without a VBScript wrapper,
; which antivirus heuristics dislike.
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\{#IconPath}"; Comment: "The browser you and your AI agents share"; Flags: runminimized
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\{#IconPath}"; Flags: runminimized; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Run]
; The conventional "launch it now" checkbox, running exactly what the Start
; Menu shortcut runs. (--doctor, which installers often use here, does not exist
; in this package -- test/installer.test.mjs checks that against the real CLI.)
Filename: "{app}\{#AppExeName}"; Parameters: "--open"; WorkingDir: "{app}"; Description: "Open {#AppName}"; Flags: postinstall nowait skipifsilent runminimized

[Code]
// Whether the install directory is missing from the user's PATH.
//
// Line comments, not { }: a Pascal block comment does not nest, so naming an
// Inno constant inside one ends the comment at that constant's closing brace
// and the rest of the sentence is compiled as code.
//
// Compared with a semicolon on both ends so that a directory whose name is a
// suffix of an existing entry is not mistaken for it.
function NeedsAddPath(Dir: string): boolean;
var
  Existing: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Existing) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Existing) + ';') = 0;
end;

// Take the entry back out on uninstall.
//
// Without this every install/uninstall cycle leaves another dead directory on
// the user's PATH, and they accumulate silently.
procedure RemoveFromPath(Dir: string);
var
  Existing: string;
  At: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Existing) then
    exit;
  At := Pos(';' + Uppercase(Dir), ';' + Uppercase(Existing));
  if At = 0 then
    exit;
  Delete(Existing, At, Length(Dir) + 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Existing);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromPath(ExpandConstant('{app}'));
end;

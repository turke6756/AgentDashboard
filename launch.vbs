Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\turke\Projects\AgentDashboard"
WshShell.Run "cmd /c npm run build && npm start", 0, False

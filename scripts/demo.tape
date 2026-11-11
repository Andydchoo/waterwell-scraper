# Records scripts/demo.sh to docs/demo.mp4. Run from the project root:
#   vhs scripts/demo.tape
Output docs/demo.mp4

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 15
Set Width 1500
Set Height 860
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 0

Hide
Type "export PS1='❯ '; clear"
Enter
Type "scripts/demo.sh"
Enter
Sleep 2s
Show

# Wait+Screen only sees the first screenful once output scrolls, so wait for
# the prompt to return on the cursor line instead.
Wait+Line@300s /❯/
Sleep 4s

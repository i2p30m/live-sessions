# live-sessions — „Sesje na żywo”

Mod do Claude Code (zakładka Code w aplikacji desktopowej Claude): panel obok rozmowy, który pokazuje wszystkie Twoje sesje i od razu widać, w jakim są stanie.

- **Czeka na Ciebie**: sesja zadała pytanie, czeka na akceptację planu albo na zgodę na narzędzie.
- **Pracuje** i **Czeka na pracę w tle**, z rozwijaną listą zadań w tle (shell, subagenci).
- **Skończone, do sprawdzenia**: sesja skończyła, a Ty jeszcze jej nie otworzyłeś (✓ oznacza jako sprawdzoną).
- **Projekty**: pozostałe sesje pogrupowane po projektach, od ostatnio używanego, z sesjami pobocznymi pod sesją, która je uruchomiła. Liczbę sesji na projekt wybierasz na górze.

Kliknięcie tytułu otwiera sesję. ↓ przenosi sesję z góry do jej projektu, ↑ z powrotem na górę. Nic nie jest archiwizowane ani usuwane: to tylko widok w panelu, a sesja z nową aktywnością sama wraca na górę.

Panel otwiera się sam przy starcie sesji albo przy pierwszej wiadomości; `/sesje` otwiera go ponownie po zamknięciu.

## Instalacja

W terminalu, w sesji Claude Code:

```
/plugin install live-sessions --marketplace i2p30m/live-sessions
```

Potwierdź dodanie marketplace (`y`) i wybierz zakres użytkownika (user).

Z powłoki:

```
claude plugin install live-sessions --marketplace i2p30m/live-sessions
```

W aplikacji desktopowej, gdzie `/plugin` nie działa: kliknij + obok pola wiadomości, potem Plugins, Add marketplace z `i2p30m/live-sessions`, potem Add plugin.

Mod działa w sesjach uruchomionych po instalacji.

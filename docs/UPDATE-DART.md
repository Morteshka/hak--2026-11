# Обновление для Dart и Flutter

Новые методы панели администратора, форматы запросов и пагинация описаны в [обновлении администрирования](UPDATE-ADMIN.md).

При создании мероприятия поле `sport` принимает свободный текст от 2 до 60 символов. Покажите обычное текстовое поле. В фильтре афиши можно использовать уникальные значения `sport` из ответа `GET /api/events`. Поле видно администратору и появляется в карточке после публикации.

## Временный адрес для отладки

После включения HTTP-порта базовый адрес на VPS — `http://45.9.117.195/api`. Swagger находится на `http://45.9.117.195/docs`, контракт — на `http://45.9.117.195/api/openapi.json`.

HTTP пригоден для тестовых аккаунтов и фиктивных данных. Пароли, идентификаторы и JWT на этом адресе идут без шифрования. В рабочей сборке используйте доступный устройству HTTPS-адрес с доверенным сертификатом. Тестовый HTTP и действующий HTTPS работают с одной SQLite и одним API.

### Проверка подключения

```sh
curl -i http://45.9.117.195/api
curl -i http://45.9.117.195/api/events
```

Первый запрос возвращает `{"ok":true,"openapi":"/api/openapi.json","docs":"/docs"}` без входа. Для Flutter Web предварительный `OPTIONS /api/register` с заголовками `Origin`, `Access-Control-Request-Method: POST` и `Access-Control-Request-Headers: content-type` возвращает `204`.

В отладочной сборке задайте адрес отдельно от кода:

```sh
flutter run --dart-define=TEMP_API_BASE=http://45.9.117.195/api
```

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

const apiBase = String.fromEnvironment('TEMP_API_BASE');

Future<String> signIn(String email, String password) async {
  final res = await http.post(
    Uri.parse('$apiBase/login'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'email': email, 'password': password}),
  );
  final data = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  if (res.statusCode != 200) {
    throw StateError(data['error'] as String? ?? 'Ошибка входа');
  }
  return data['token'] as String;
}

Future<Map<String, dynamic>> loadWallet(String token) async {
  final res = await http.get(
    Uri.parse('$apiBase/wallet'),
    headers: {'Authorization': 'Bearer $token'},
  );
  final data = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  if (res.statusCode != 200) {
    throw StateError(data['error'] as String? ?? 'Не удалось загрузить баланс');
  }
  return data;
}
```

JWT передаётся как `Authorization: Bearer <token>`. При `401` очистите токен и предложите повторный вход. Ошибка API имеет вид `{"error":"сообщение"}`. QR по `GET /api/tickets/{id}/qr` возвращается как `image/png`. Передайте `bodyBytes` в `Image.memory`.

- **Flutter Android и iOS.** Если система блокирует HTTP, добавьте исключение для тестового адреса в отладочную сетевую конфигурацию. У Android она находится в `android/app/src/debug`. У iOS настройте ATS в debug Info.plist. [Руководство Flutter](https://docs.flutter.dev/release/breaking-changes/network-policy-ios-android) · [Android Network Security Config](https://developer.android.com/privacy-and-security/security-config) · [Apple ATS](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)
- **Flutter Web.** API поддерживает CORS для JSON и заголовка `Authorization`. При обращении с другого адреса оставьте `withCredentials = false` и передавайте JWT как `Authorization: Bearer <token>`. Вход и регистрация возвращают JWT в JSON. Cookie используются только самим сайтом. Страница, открытая по HTTPS, требует HTTPS API с доверенным сертификатом либо прокси на адресе фронтенда.

## Баллы, покупки и украшения

| Запрос | Для чего |
| --- | --- |
| `GET /api/wallet` | Баланс, последние 50 операций, заказы, выбранное оформление и прогресс наград организатора |
| `GET /api/shop/products` | Публичная витрина. `stock: null` означает цифровой товар |
| `POST /api/shop/orders` | Покупка. Отправьте `{product,requestId}`. После тайм-аута повторите с тем же ключом, чтобы избежать второго списания |
| `PUT /api/profile/decoration` | Выбор украшений. Отправьте `{badge,theme}` с ID заказов или `null` для снятия |
| `GET /api/people/{id}` | Публичный профиль с оформлением и спортивными счётчиками |
| `GET /api/admin/shop` | Управление каталогом и заказами на выдачу |
| `POST /api/admin/shop/products` | Добавление физического товара, значка или темы |
| `PUT /api/admin/shop/products/{id}` | Редактирование товара. Для физического товара отправьте `expectedStock` из свежего списка |
| `POST /api/admin/shop/orders/{id}` | Готовность, выдача или отмена. Отмена возвращает баллы и остаток |

У пользователя 10 баллов за подтверждённое участие. Организатор получает 30 за завершённое одобренное мероприятие с участником и 40 за каждые пять таких событий. Баланс и XP — разные поля. Покупка цифрового товара даёт `fulfilled`. Физический заказ начинается с `reserved`, переходит в `ready` и затем `fulfilled`. Инструкция по получению находится в `pickup`. [Тела запросов, статусы и примеры](UPDATE-SHOP.md)

## Серии и рейтинг

| Запрос | Для чего |
| --- | --- |
| `GET /api/organizers/leaderboard?year=2025` | Рейтинг организаторов и доступные годы в `years` |
| `GET /api/series/leaderboard?year=2025` | Рейтинг серий. Без года учитываются все сезоны |
| `GET /api/series/mine` | Серии текущего организатора |
| `GET /api/series/{id}` | Выпуски в хронологическом порядке. У выпуска есть `edition`, `year`, `seriesYear`, `completed` и число посещений `attended` |
| `PUT /api/events/{id}/series` | Связать существующее мероприятие с серией через `seriesId` или создать серию через `seriesTitle` |

При создании события `POST /api/events` принимает те же необязательные поля `seriesId` и `seriesTitle`. У связанной карточки `GET /api/events/{id}` появляется `seriesId`. Для списка истории фильтруйте `editions` по `completed == true`. Например, `edition: 4` и `seriesYear: 4` означает «4-й выпуск · 4-й год серии». В рейтинг входят завершённые одобренные выпуски с подтверждённым участником. [Форматы ответов и правила нумерации](UPDATE-SERIES.md)

[Основной справочник API](API.md) · [OpenAPI](../openapi.json)

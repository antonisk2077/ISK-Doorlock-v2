fresh-build:
	docker compose down && docker compose build --no-cache && docker compose up -d

build:
	docker compose up -d --build

user:
	docker exec -it isk-doorlock sh -lc "npm run create-users"

db-logs:
	docker logs -f isk-doorlock-db

logs:
	docker logs -f isk-doorlock

down:
	docker compose down

restart:
	docker compose down && docker compose up -d --build


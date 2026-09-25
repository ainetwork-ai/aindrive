package ai.ainetwork.aindrive.agent;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Korean → English for the words people use to describe what is IN a photo.
 * CLIP was trained on English captions, so "강아지 사진" is asked as
 * "a photo of a dog". Unknown words pass through unchanged (CLIP copes with
 * some Korean, and the file-name match still runs on the original word).
 */
public final class ContentWords {
    private static final Map<String, String> KO = new HashMap<>();
    static {
        String[][] t = {
                // animals
                {"강아지", "dog"}, {"개", "dog"}, {"멍멍이", "dog"}, {"고양이", "cat"}, {"냥이", "cat"}, {"새", "bird"}, {"물고기", "fish"}, {"말", "horse"}, {"소", "cow"}, {"토끼", "rabbit"}, {"햄스터", "hamster"}, {"동물", "animal"},
                // places / scenery
                {"바다", "the sea and beach"}, {"해변", "beach"}, {"해수욕장", "beach"}, {"산", "mountains"}, {"강", "river"}, {"호수", "lake"}, {"숲", "forest"}, {"공원", "park"}, {"도시", "city"}, {"거리", "street"}, {"골목", "alley"},
                {"야경", "city at night"}, {"밤", "night"}, {"노을", "sunset"}, {"일몰", "sunset"}, {"일출", "sunrise"}, {"하늘", "sky"}, {"구름", "clouds"}, {"눈", "snow"}, {"비", "rain"}, {"폭포", "waterfall"}, {"사막", "desert"}, {"섬", "island"},
                {"에펠탑", "the Eiffel Tower"}, {"루브르", "the Louvre museum"}, {"박물관", "museum"}, {"성당", "cathedral"}, {"교회", "church"}, {"절", "temple"}, {"궁", "palace"}, {"궁전", "palace"}, {"다리", "bridge"}, {"고층빌딩", "skyscrapers"}, {"빌딩", "buildings"}, {"건물", "building"},
                {"한강", "the Han River in Seoul"}, {"시부야", "Shibuya crossing in Tokyo"}, {"횡단보도", "crosswalk"},
                // things
                {"자동차", "car"}, {"차", "car"}, {"스포츠카", "sports car"}, {"자전거", "bicycle"}, {"오토바이", "motorcycle"}, {"버스", "bus"}, {"기차", "train"}, {"비행기", "airplane"}, {"배", "boat"}, {"보트", "boat"},
                {"영수증", "a paper receipt"}, {"화이트보드", "a whiteboard with writing"}, {"칠판", "blackboard"}, {"문서", "document"}, {"메모", "handwritten note"}, {"명함", "business card"}, {"책", "book"}, {"노트북", "laptop"}, {"컴퓨터", "computer"}, {"핸드폰", "smartphone"}, {"휴대폰", "smartphone"},
                {"꽃", "flowers"}, {"벚꽃", "cherry blossoms"}, {"장미", "roses"}, {"나무", "tree"}, {"단풍", "autumn leaves"},
                // food & drink
                {"음식", "food on a plate"}, {"밥", "a meal"}, {"식사", "a meal"}, {"피자", "pizza"}, {"라면", "a bowl of ramen"}, {"라멘", "a bowl of ramen"}, {"국수", "noodles"}, {"파스타", "pasta"}, {"햄버거", "hamburger"}, {"치킨", "fried chicken"}, {"고기", "grilled meat"}, {"스테이크", "steak"}, {"초밥", "sushi"}, {"스시", "sushi"}, {"빵", "bread"}, {"크루아상", "croissant"}, {"케이크", "cake"}, {"디저트", "dessert"}, {"과일", "fruit"}, {"커피", "a cup of coffee"}, {"라떼", "latte"}, {"맥주", "beer"}, {"와인", "wine"}, {"술", "drinks"},
                // people & events
                {"사람", "a person"}, {"사람들", "people"}, {"아기", "baby"}, {"아이", "child"}, {"아이들", "children"}, {"가족", "family"}, {"친구", "friends"}, {"셀카", "selfie"}, {"셀피", "selfie"}, {"얼굴", "face"}, {"단체", "group of people"},
                {"결혼식", "wedding"}, {"생일", "birthday cake with candles"}, {"파티", "party"}, {"콘서트", "concert"}, {"공연", "concert stage"}, {"축제", "festival"}, {"회의", "meeting room"}, {"발표", "presentation"}, {"졸업", "graduation"},
                // activities
                {"등산", "hiking"}, {"캠핑", "camping"}, {"낚시", "fishing"}, {"수영", "swimming"}, {"축구", "soccer"}, {"야구", "baseball"}, {"농구", "basketball"}, {"골프", "golf"}, {"스키", "skiing"}, {"운동", "sports"}, {"달리기", "running"}, {"여행", "travel"},
                // adjectives that often come with a subject ("빨간 스포츠카", "귀여운 강아지")
                {"빨간", "red"}, {"빨강", "red"}, {"파란", "blue"}, {"노란", "yellow"}, {"초록", "green"}, {"녹색", "green"}, {"검은", "black"}, {"검정", "black"}, {"하얀", "white"}, {"흰", "white"}, {"분홍", "pink"}, {"보라", "purple"},
                {"작은", "small"}, {"귀여운", "cute"}, {"예쁜", "beautiful"}, {"오래된", "old"}, {"낡은", "old"}, {"새로운", "new"}, {"밝은", "bright"}, {"어두운", "dark"},
                // misc
                {"밤하늘", "night sky"}, {"별", "stars"}, {"달", "the moon"}, {"불꽃놀이", "fireworks"}, {"무지개", "rainbow"}, {"풍경", "landscape"}, {"풍경사진", "landscape"}, {"인물", "portrait"}, {"인물사진", "portrait"}, {"흑백", "black and white photo"},
        };
        for (String[] p : t) KO.put(p[0], p[1]);
    }

    /** English phrase for a content word; the word itself when unknown. */
    public static String toEnglish(String word) {
        String w = word.trim();
        String hit = KO.get(w);
        if (hit != null) return hit;
        // "고양이들", "강아지가" etc. — try the longest known prefix (particles were already stripped).
        for (int cut = w.length() - 1; cut >= 2; cut--) {
            hit = KO.get(w.substring(0, cut));
            if (hit != null) return hit;
        }
        return w.toLowerCase(Locale.ROOT);
    }
}
